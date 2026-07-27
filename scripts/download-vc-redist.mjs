#!/usr/bin/env node

/**
 * Download the Microsoft Visual C++ Redistributable (x64) for bundling
 * with the Windows NSIS installer.
 *
 * Downloads from https://aka.ms/vs/17/release/vc_redist.x64.exe to
 * build/vc_redist.x64.exe. Skips download when the file already exists
 * and has a non-zero size.
 *
 * Usage:
 *   node scripts/download-vc-redist.mjs
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { get } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "build", "vc_redist.x64.exe");
const REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

const OUTPUT_DIR = dirname(OUTPUT);

// Ensure the target directory exists.
mkdirSync(OUTPUT_DIR, { recursive: true });

// Skip if the file already exists and has a non-zero size.
if (existsSync(OUTPUT)) {
  try {
    const stat = statSync(OUTPUT);
    if (stat.size > 0) {
      process.stdout.write(
        `✓ VC++ Redistributable already present (${(stat.size / 1024 / 1024).toFixed(1)} MB). Skipping download.\n`,
      );
      process.exit(0);
    }

    process.stdout.write(
      "⚠ Existing VC++ Redistributable file is empty. Re-downloading.\n",
    );
  } catch {
    // File exists but can't stat. Re-download.
    process.stdout.write(
      "⚠ Cannot stat existing VC++ Redistributable file. Re-downloading.\n",
    );
  }
}

process.stdout.write(`⬇ Downloading VC++ Redistributable from ${REDIST_URL}...\n`);

/**
 * Follow redirects (the aka.ms URL will redirect to a cdn-download URL) and
 * stream the response to disk.
 */
function download(url, maxRedirects = 5) {
  if (maxRedirects <= 0) {
    process.stderr.write("❌ Too many redirects while downloading VC++ Redistributable.\n");
    process.exit(1);
  }

  get(url, (response) => {
    const { statusCode, headers } = response;

    // Follow redirect.
    if (statusCode >= 301 && statusCode <= 308 && headers.location) {
      response.resume();
      download(headers.location, maxRedirects - 1);
      return;
    }

    if (statusCode !== 200) {
      process.stderr.write(
        `❌ Download failed with HTTP ${statusCode}.\n`,
      );
      response.resume();
      process.exit(1);
    }

    const contentLength = headers["content-length"];
    if (contentLength) {
      const sizeMB = (Number.parseInt(contentLength, 10) / 1024 / 1024).toFixed(1);
      process.stdout.write(`   Size: ${sizeMB} MB\n`);
    }

    const fileStream = createWriteStream(OUTPUT);

    response.pipe(fileStream);

    fileStream.on("finish", () => {
      fileStream.close(() => {
        const written = statSync(OUTPUT).size;
        const writtenMB = (written / 1024 / 1024).toFixed(1);

        if (contentLength && written !== Number.parseInt(contentLength, 10)) {
          process.stderr.write(
            `❌ Downloaded size (${writtenMB} MB) does not match expected size.\n`,
          );
          process.exit(1);
        }

        process.stdout.write(
          `✓ VC++ Redistributable saved to build/vc_redist.x64.exe (${writtenMB} MB).\n`,
        );
        process.exit(0);
      });
    });

    fileStream.on("error", (err) => {
      process.stderr.write(
        `❌ Failed to write VC++ Redistributable: ${err.message}\n`,
      );
      process.exit(1);
    });

    response.on("error", (err) => {
      process.stderr.write(
        `❌ Download stream error: ${err.message}\n`,
      );
      fileStream.destroy();
      process.exit(1);
    });
  }).on("error", (err) => {
    process.stderr.write(
      `❌ Download request error: ${err.message}\n`,
    );
    process.exit(1);
  });
}

download(REDIST_URL);
