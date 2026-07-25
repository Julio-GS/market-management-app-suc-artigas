import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDir, "..");
const frontendRoot = path.resolve(desktopRoot, "../frontend-management-market/supermarket-management-frontend");
const nextRoot = path.join(frontendRoot, ".next");
const standaloneRoot = path.join(nextRoot, "standalone");
const staticRoot = path.join(nextRoot, "static");
const publicRoot = path.join(frontendRoot, "public");
const targetRoot = path.join(desktopRoot, "build", "frontend", "standalone");
const tracedPnpmNodeModulesMarker = "node_modules/.pnpm/node_modules/";

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

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function normalizeTracePath(tracePath) {
  return tracePath.replace(/\\/g, "/");
}

export function extractTracedPackageName(tracePath) {
  const normalizedTracePath = normalizeTracePath(tracePath);
  const markerIndex = normalizedTracePath.indexOf(tracedPnpmNodeModulesMarker);

  if (markerIndex === -1) {
    return undefined;
  }

  const packagePath = normalizedTracePath
    .slice(markerIndex + tracedPnpmNodeModulesMarker.length)
    .split("/")
    .filter(Boolean);

  if (packagePath.length === 0) {
    return undefined;
  }

  if (packagePath[0].startsWith("@")) {
    if (packagePath.length < 2) {
      return undefined;
    }

    return `${packagePath[0]}/${packagePath[1]}`;
  }

  return packagePath[0];
}

export function collectTracedPackages(traceManifests) {
  const packages = new Set();

  for (const traceManifest of traceManifests) {
    for (const tracePath of traceManifest.files ?? []) {
      const packageName = extractTracedPackageName(tracePath);
      if (packageName) {
        packages.add(packageName);
      }
    }
  }

  return packages;
}

async function collectTraceFiles(directory) {
  if (!(await pathExists(directory))) {
    return [];
  }

  const traceFiles = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      traceFiles.push(...await collectTraceFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".nft.json")) {
      traceFiles.push(entryPath);
    }
  }

  return traceFiles;
}

async function findRelevantTraceFiles() {
  const requiredTraceFiles = [
    path.join(nextRoot, "next-server.js.nft.json"),
    path.join(nextRoot, "next-minimal-server.js.nft.json"),
  ];
  const routeTraceFiles = await collectTraceFiles(path.join(nextRoot, "server"));

  return [...new Set([...requiredTraceFiles, ...routeTraceFiles])];
}

async function readTraceManifests(traceFiles) {
  const manifests = [];

  for (const traceFile of traceFiles) {
    if (!(await pathExists(traceFile))) {
      continue;
    }

    manifests.push(await readJsonFile(traceFile));
  }

  return manifests;
}

function packageTargetPath(packageName) {
  return path.join(targetRoot, "node_modules", ...packageName.split("/"));
}

function packageSourcePath(packageName) {
  return path.join(frontendRoot, "node_modules", ".pnpm", "node_modules", ...packageName.split("/"));
}

async function materializeTracedRuntimePackages() {
  const traceFiles = await findRelevantTraceFiles();
  const traceManifests = await readTraceManifests(traceFiles);
  const tracedPackages = collectTracedPackages(traceManifests);
  let copiedPackageCount = 0;
  let skippedPackageCount = 0;

  for (const packageName of tracedPackages) {
    const sourcePackageRoot = packageSourcePath(packageName);
    const sourcePackageJson = path.join(sourcePackageRoot, "package.json");

    if (!(await pathExists(sourcePackageJson))) {
      skippedPackageCount += 1;
      console.warn(`Skipping missing traced frontend runtime package ${packageName} at ${sourcePackageRoot}`);
      continue;
    }

    const targetPackageRoot = packageTargetPath(packageName);

    await fs.mkdir(path.dirname(targetPackageRoot), { recursive: true });
    await copyDirectory(sourcePackageRoot, targetPackageRoot);
    copiedPackageCount += 1;
  }

  console.log(`Materialized ${copiedPackageCount} traced frontend runtime packages`);
  console.log(`Skipped ${skippedPackageCount} traced frontend runtime packages`);
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

  await materializeTracedRuntimePackages();

  console.log(`Copied Next standalone app from ${standaloneAppRoot}`);
  console.log(`Desktop frontend bundle ready at ${targetRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
