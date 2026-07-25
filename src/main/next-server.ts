import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

export interface NextServerHandle {
  url: string;
  stop(): void;
}

export interface StartPackagedNextServerOptions {
  port?: number;
  hostname?: string;
}

export interface WaitForServerReadyOptions {
  child: Pick<ChildProcessWithoutNullStreams, "once" | "removeListener">;
  url: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  probe?: (url: string) => Promise<boolean>;
}

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 3002;
const SERVER_READY_TIMEOUT_MS = 15_000;
const SERVER_READY_POLL_INTERVAL_MS = 250;

let runningServer: ChildProcessWithoutNullStreams | null = null;

export async function startPackagedNextServer(options: StartPackagedNextServerOptions = {}): Promise<NextServerHandle> {
  const hostname = app.isPackaged ? DEFAULT_HOSTNAME : options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;
  const url = `http://${hostname}:${port}/`;
  const standaloneRoot = path.join(process.resourcesPath, "frontend", "standalone");
  const standaloneServerPath = path.join(standaloneRoot, "server.js");

  if (!app.isPackaged) {
    return {
      url,
      stop: () => undefined
    };
  }

  if (!fs.existsSync(standaloneServerPath)) {
    throw new Error(`Packaged Next server was not found at ${standaloneServerPath}`);
  }

  log.info("Starting packaged Next server", {
    standaloneRoot,
    standaloneServerPath,
    url
  });

  runningServer = spawn(process.execPath, [standaloneServerPath], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: hostname,
      PORT: String(port)
    },
    stdio: "pipe",
    windowsHide: true
  });

  runningServer.stdout.on("data", (chunk) => log.info(`[next] ${String(chunk).trim()}`));
  runningServer.stderr.on("data", (chunk) => log.error(`[next] ${String(chunk).trim()}`));
  runningServer.on("error", (error) => log.error("Packaged Next server process error", error));
  runningServer.on("exit", (code, signal) => log.info("Packaged Next server exited", { code: code ?? "unknown", signal: signal ?? "none" }));

  try {
    await waitForServerReady({
      child: runningServer,
      url
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error("Packaged Next server failed to become ready", {
      standaloneRoot,
      standaloneServerPath,
      url,
      reason
    });
    stopPackagedNextServer();
    throw new Error(`Failed to start packaged Next server at ${url}: ${reason}`);
  }

  log.info("Packaged Next server is ready", { url });

  return {
    url,
    stop: () => stopPackagedNextServer()
  };
}

export async function waitForServerReady(options: WaitForServerReadyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SERVER_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SERVER_READY_POLL_INTERVAL_MS;
  const probe = options.probe ?? probeHttpServer;
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | null = null;

  return await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.child.removeListener("exit", onExit);
      options.child.removeListener("error", onError);
    };

    const fail = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(`Packaged Next server exited before becoming ready (code: ${code ?? "unknown"}, signal: ${signal ?? "none"})`);
    };

    const onError = (error: Error): void => {
      fail(`Packaged Next server failed before becoming ready (${error.message})`);
    };

    const scheduleNextAttempt = (): void => {
      if (Date.now() - startedAt >= timeoutMs) {
        fail(`Timed out waiting for packaged Next server at ${options.url} after ${timeoutMs}ms (${lastError ?? "no response"})`);
        return;
      }

      timer = setTimeout(() => {
        void attempt();
      }, pollIntervalMs);
    };

    const attempt = async (): Promise<void> => {
      try {
        if (await probe(options.url)) {
          succeed();
          return;
        }
        lastError = "server not reachable yet";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      scheduleNextAttempt();
    };

    options.child.once("exit", onExit);
    options.child.once("error", onError);
    void attempt();
  });
}

async function probeHttpServer(url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const request = http.get(url, (response) => {
      response.resume();
      finish((response.statusCode ?? 0) > 0);
    });

    request.setTimeout(2_000, () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
  });
}

export function stopPackagedNextServer(): void {
  if (runningServer && !runningServer.killed) {
    runningServer.kill();
  }

  runningServer = null;
}
