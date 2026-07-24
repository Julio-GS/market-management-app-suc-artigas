import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDir, "..");
const frontendRoot = path.resolve(desktopRoot, "../frontend-management-market/supermarket-management-frontend");
const standaloneRoot = path.join(frontendRoot, ".next", "standalone");
const staticRoot = path.join(frontendRoot, ".next", "static");
const publicRoot = path.join(frontendRoot, "public");
const targetRoot = path.join(desktopRoot, "build", "frontend", "standalone");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findServerFile(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const directServer = entries.find((entry) => entry.isFile() && entry.name === "server.js");

  if (directServer) {
    return path.join(directory, directServer.name);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }

    const nestedResult = await findServerFile(path.join(directory, entry.name));
    if (nestedResult) {
      return nestedResult;
    }
  }

  return undefined;
}

async function copyDirectory(source, target) {
  await fs.cp(source, target, { recursive: true, force: true, dereference: true });
}

async function main() {
  if (!(await pathExists(standaloneRoot))) {
    throw new Error(`Next standalone output was not found at ${standaloneRoot}. Run the frontend build first.`);
  }

  const serverFile = await findServerFile(standaloneRoot);
  if (!serverFile) {
    throw new Error(`Could not find server.js under ${standaloneRoot}.`);
  }

  const standaloneAppRoot = path.dirname(serverFile);

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await copyDirectory(standaloneAppRoot, targetRoot);

  if (await pathExists(staticRoot)) {
    await copyDirectory(staticRoot, path.join(targetRoot, ".next", "static"));
  }

  if (await pathExists(publicRoot)) {
    await copyDirectory(publicRoot, path.join(targetRoot, "public"));
  }

  console.log(`Copied Next standalone app from ${standaloneAppRoot}`);
  console.log(`Desktop frontend bundle ready at ${targetRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
