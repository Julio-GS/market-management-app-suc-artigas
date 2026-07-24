# Market Management — Desktop

Electron desktop shell for the Market Management system.

This repository contains the desktop wrapper. The existing Next.js frontend and NestJS backend remain the source of application behavior. Slice 1 only establishes the desktop workspace and build tooling.

## Prerequisites

- Node.js 20+
- pnpm

## Scaffold commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm dev
pnpm prepare:frontend
pnpm package:dir
pnpm package
```

> On Windows, `electron-builder` may require Developer Mode or elevated symlink privileges while extracting signing helpers. If packaging fails with `Cannot create symbolic link`, enable Developer Mode or run the packaging command from an elevated terminal.

## Current slice status

| Slice | Status |
| --- | --- |
| Slice 1 — Scaffold workspace and build tooling | Done |
| Slice 2 — Secure Electron shell | Done |
| Slice 3 — Frontend standalone/runtime config integration | Done |
| Slice 4 — Production packaging and asset pipeline | Done |
| Slice 5 — Update-ready scaffolding | Done |
| Slice 6 — Verification checklist | Done |
| Slice 7 — GitHub Releases auto-update | In progress |

## Project structure

```text
src/
  main/       Electron main process
  preload/    Minimal preload bridge
```

## Smoke checklist

See [`docs/desktop-smoke.md`](./docs/desktop-smoke.md) for the operator/developer verification checklist covering parity flows, packaging, update-disabled fallback, and Windows packaging guidance.

## Publishing to GitHub Releases

A `publish:github` script is available that publishes the Windows NSIS installer to GitHub Releases. Local packaging (`pnpm package` / `pnpm package:dir`) remains non-publishing (`--publish never`).

```bash
# Set the GitHub token before publishing
export GH_TOKEN=<your-token>   # or $env:GH_TOKEN on PowerShell

# Publish a new release
pnpm publish:github
```

The script runs `scripts/require-gh-token.mjs` as a preflight, which fails fast when `GH_TOKEN` is missing or too short.

### Release assets

After publishing, the GitHub Release includes:

- `Market Management Setup <version>.exe` — NSIS installer (x64 Windows)
- `.exe.blockmap`
- `latest.yml` — metadata consumed by `electron-updater`

### Prerequisites

| Dependency | Status |
| --- | --- |
| `GH_TOKEN` with repository release permissions | Required for publish; stored as operator/CI secret |
| Windows Authenticode signing certificate | Optional for internal validation; required for production (avoids SmartScreen warnings). Set via `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables. |
| GitHub repository visibility | Public releases are supported. Private repository updates require additional authentication configuration and are not production-ready in this slice. |

### Rollback and recovery

- Disable updates through runtime config if the update path misbehaves.
- Remove or draft a bad GitHub Release.
- Publish a fixed higher semver version; downgrade is blocked by default.
- Manual reinstall using a known-good installer is the final recovery path.
- Explicit downgrade can be allowed only through a support/recovery config override (`allowDowngrade: true`).

## Notes

- In development, the app loads `FRONTEND_DEV_URL` or `http://localhost:3001` by default.
- `MARKET_API_BASE_URL` config is resolved by Electron and exposed to the preload bridge for later frontend integration.
- `pnpm prepare:frontend` builds the existing Next.js frontend and copies `.next/standalone`, `.next/static`, and `public` into `build/frontend/standalone`.
- In production, Electron starts the packaged Next server from `resources/frontend/standalone/server.js` bound to `127.0.0.1`.
- `electron-builder.yml` includes `build/frontend` as unpacked extra resources and configures GitHub Releases publishing.
- Updates are scaffolded through `electron-updater` with GitHub Releases as the provider. They are disabled by default in `build/default-config.json`.
- To enable updates, set `updates.enabled: true` in runtime config. The default GitHub owner/repo is pre-configured in `build/default-config.json`.
- The update flow is user-confirmed: the renderer must call `updates.check()` → `updates.download()` → `updates.installAndRestart()`. No automatic download or install is performed.
