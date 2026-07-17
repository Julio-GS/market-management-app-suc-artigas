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

## Project structure

```text
src/
  main/       Electron main process
  preload/    Minimal preload bridge
```

## Smoke checklist

See [`docs/desktop-smoke.md`](./docs/desktop-smoke.md) for the operator/developer verification checklist covering parity flows, packaging, update-disabled fallback, and Windows packaging guidance.

## Notes

- In development, the app loads `FRONTEND_DEV_URL` or `http://localhost:3001` by default.
- `MARKET_API_BASE_URL` config is resolved by Electron and exposed to the preload bridge for later frontend integration.
- `pnpm prepare:frontend` builds the existing Next.js frontend and copies `.next/standalone`, `.next/static`, and `public` into `build/frontend/standalone`.
- In production, Electron starts the packaged Next server from `resources/frontend/standalone/server.js` bound to `127.0.0.1`.
- `electron-builder.yml` includes `build/frontend` as unpacked extra resources and keeps publishing disabled by default.
- Updates are scaffolded through `electron-updater` but disabled by default in `build/default-config.json`.
- To enable updates later, provide a signed Windows build plus a generic HTTPS provider serving Electron Builder metadata/artifacts, then set `updates.enabled`, `updates.provider`, and `updates.url` in runtime config.
