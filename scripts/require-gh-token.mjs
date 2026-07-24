#!/usr/bin/env node

/**
 * Preflight check for GitHub Releases publishing.
 *
 * Fails fast with a clear message when GH_TOKEN is missing or empty.
 * Run before `electron-builder --publish always` so the build does not
 * silently skip publishing or fail with a confusing error later.
 *
 * Usage:
 *   node scripts/require-gh-token.mjs
 */

import process from "node:process";

const token = process.env.GH_TOKEN;

if (!token || token.trim().length === 0) {
  process.stderr.write(
    "❌ GH_TOKEN is not set or is empty.\n" +
      "\n" +
      "  Publishing to GitHub Releases requires a personal access token with\n" +
      "  appropriate repository permissions.\n" +
      "\n" +
      "  Set the token before running the publish command:\n" +
      "\n" +
      "    macOS / Linux:  export GH_TOKEN=<your-token>\n" +
      "    Windows (cmd):  set GH_TOKEN=<your-token>\n" +
      "    Windows (ps):   $env:GH_TOKEN = \"<your-token>\"\n" +
      "\n" +
      "  For local packaging (no publish), use `pnpm package` instead of\n" +
      "  `pnpm publish:github`.\n",
  );
  process.exit(1);
}

// Minimal sanity: token must be at least 20 characters and not obviously malformed.
if (token.trim().length < 20) {
  process.stderr.write(
    "❌ GH_TOKEN is too short to be a valid GitHub token.\n",
  );
  process.exit(1);
}

process.stdout.write("✓ GH_TOKEN is present.\n");
process.exit(0);
