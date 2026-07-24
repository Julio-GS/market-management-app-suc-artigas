import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
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

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 3002;

let runningServer: ChildProcessWithoutNullStreams | null = null;

export async function startPackagedNextServer(options: StartPackagedNextServerOptions = {}): Promise<NextServerHandle> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;
  const standaloneRoot = path.join(process.resourcesPath, "frontend", "standalone");
  const standaloneServerPath = path.join(standaloneRoot, "server.js");

  if (!app.isPackaged) {
    return {
      url: `http://${hostname}:${port}`,
      stop: () => undefined
    };
  }

  if (!fs.existsSync(standaloneServerPath)) {
    throw new Error(`Packaged Next server was not found at ${standaloneServerPath}`);
  }

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
  runningServer.on("exit", (code) => log.info(`Packaged Next server exited with code ${code ?? "unknown"}`));

  return {
    url: `http://${hostname}:${port}`,
    stop: () => stopPackagedNextServer()
  };
}

export function stopPackagedNextServer(): void {
  if (runningServer && !runningServer.killed) {
    runningServer.kill();
  }

  runningServer = null;
}
