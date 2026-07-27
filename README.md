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
pnpm prepare:vc-redist
pnpm package:dir
pnpm package
```

> On Windows, `electron-builder` may require Developer Mode or elevated symlink privileges while extracting signing helpers. If packaging fails with `Cannot create symbolic link`, enable Developer Mode or run the packaging command from an elevated terminal.

> The installer bundles the Microsoft Visual C++ Redistributable (x64) so `better-sqlite3` works on clean Windows PCs without a separate VC++ runtime install. `pnpm prepare:vc-redist` downloads the redistributable before packaging; it is included in the NSIS installer and run silently during setup.

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

See [`docs/desktop-smoke.md`](./docs/desktop-smoke.md) for the operator/developer verification checklist covering parity flows, packaging, update defaults, CI releases, and Windows packaging guidance.

## Releasing with GitHub Actions

The primary release path is a tag-triggered GitHub Actions workflow (`.github/workflows/release.yml`). Local publishing is an emergency fallback only.

### Operator flow

1. Update `package.json` version to the desired release version.
2. If the bundled frontend changed, update the workflow `FRONTEND_REF` to the reviewed frontend commit SHA.
3. Commit the release-ready changes to `master`.
4. Create a matching tag on that commit: `git tag v<package.version>`.
5. Push the commit and tag: `git push origin master --tags`.
6. Watch the **Release Desktop** workflow in the Actions tab.
7. Confirm the GitHub Release contains the expected assets.

### CI workflow details

| Property | Value |
| --- | --- |
| Trigger | `v*` tag push only |
| Runner | `windows-latest` |
| Permissions | `contents: write` (declared in workflow YAML) |
| Platform | Windows NSIS x64 only; unsigned installer |

### Required GitHub setup

Create a repository secret named `GH_TOKEN`:

- Generate a Personal Access Token (classic) at `https://github.com/settings/tokens`.
- Grant at minimum the `repo` scope.
- Add the token as a repository secret in **Settings → Secrets and variables → Actions**.
- Rotate the token before it expires and update the secret.

### Release assets

After a successful CI run, the GitHub Release for the tag includes:

- `Market Management Setup <version>.exe` — NSIS installer (x64 Windows)
- `.exe.blockmap`
- `latest.yml` — metadata consumed by `electron-updater`

### Re-run policy

The workflow intentionally has no manual `workflow_dispatch` trigger. Releases must come from the tagged commit so the published assets match the reviewed source. For transient infrastructure failures, re-run the failed tag workflow from the Actions UI; do not dispatch a branch workflow to publish an existing tag.

### Emergency local fallback

`pnpm publish:github` remains available as a local emergency path when CI is unavailable. It requires `GH_TOKEN` to be set locally and runs the same `electron-builder --publish always` pipeline:

```bash
# PowerShell
$env:GH_TOKEN = "<your-token>"
pnpm publish:github
```

Local packaging commands (`pnpm package` / `pnpm package:dir`) continue to use `--publish never` and do not create GitHub Releases.

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
- Updates are scaffolded through `electron-updater` with GitHub Releases as the provider. They are enabled by default in `build/default-config.json`.
- To disable updates, set `updates.enabled: false` in runtime config. The default GitHub owner/repo is pre-configured in `build/default-config.json`.
- The update flow is user-confirmed: the renderer must call `updates.check()` → `updates.download()` → `updates.installAndRestart()`. No automatic download or install is performed.
