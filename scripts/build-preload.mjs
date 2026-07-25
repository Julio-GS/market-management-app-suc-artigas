import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
    const entries = await readdir(pnpmDir, { withFileTypes: true });
    const esbuildDir = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("esbuild@"));

    if (!esbuildDir) {
      throw new Error("esbuild is not installed. Run pnpm install before building the desktop bundle.");
    }

    const fallbackModule = join(pnpmDir, esbuildDir.name, "node_modules", "esbuild", "lib", "main.js");
    return import(pathToFileURL(fallbackModule).href);
  }
}

const esbuild = await loadEsbuild();

await esbuild.build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
});
