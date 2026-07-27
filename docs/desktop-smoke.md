# Desktop Smoke Checklist — Market Management

Use this checklist to verify that the Electron desktop shell preserves the current Next.js frontend behavior while running as a desktop app.

## Quick path

1. Start the backend API.
2. Start or build the existing frontend.
3. Run the desktop checks below.
4. For packaging, enable Windows symlink privileges if Electron Builder fails at `winCodeSign`.

## Prerequisites

- Node.js 20+
- pnpm
- Backend API available at `MARKET_API_BASE_URL` or `http://localhost:3000/api/v1`
- Frontend dev server available at `FRONTEND_DEV_URL` or `http://localhost:3001`
- Desktop repository remote: `https://github.com/Julio-GS/market-management-app-suc-basualdo.git`

## Commands

```bash
# Install desktop dependencies
pnpm install

# Desktop checks
pnpm test
pnpm typecheck
pnpm build
pnpm dev

# Frontend bundle for desktop packaging
pnpm build:frontend
pnpm copy:frontend
pnpm prepare:frontend

# Windows packaging
pnpm package:dir
pnpm package
```

## Development launch

| Check | Action | Expected result |
| --- | --- | --- |
| Desktop tests | Run `pnpm test` | Vitest passes. |
| TypeScript | Run `pnpm typecheck` | No type errors. |
| Desktop build | Run `pnpm build` | `dist/` is generated. |
| Dev shell | Run `pnpm dev` with the frontend dev server running | Electron opens the frontend from `FRONTEND_DEV_URL`. |

## Frontend bundle

| Check | Action | Expected result |
| --- | --- | --- |
| Standalone build | Run `pnpm build:frontend` | Next build completes and emits `.next/standalone`. |
| Asset copy | Run `pnpm copy:frontend` | `build/frontend/standalone/server.js`, `.next/static`, and `public` are present. |
| Full prepare | Run `pnpm prepare:frontend` | Frontend build and copy both complete. |

## Feature parity smoke tests

These checks verify current behavior only. Do not treat this list as approval for new offline, inventory, reporting, or backend features.

### Login

| Check | Action | Expected result |
| --- | --- | --- |
| Login screen | Open the app | Login UI renders as in the web frontend. |
| Valid login | Submit valid credentials | User reaches the main app. |
| Invalid login | Submit invalid credentials | Existing frontend/backend error behavior is preserved. |
| Session expiry | Use an expired token/session | Existing redirect-to-login behavior is preserved. |

### Products

| Check | Action | Expected result |
| --- | --- | --- |
| Product list | Open products screen | Products load from the backend API. |
| Product create | Create a product | Product appears after save. |
| Product edit | Edit a product | Changes persist through the backend. |
| Product delete | Delete a product allowed by current rules | Existing delete behavior is preserved. |

### Stock

| Check | Action | Expected result |
| --- | --- | --- |
| Stock display | View products with and without `maneja_stock` | Current stock/null status renders as in web. |
| Stock adjustment | Use the existing stock adjustment flow | Backend stock adjustment succeeds and UI refreshes. |
| POS stock badges | Open POS product search/scanner | Existing stock badges remain informational and do not block sales. |

### POS / sales

| Check | Action | Expected result |
| --- | --- | --- |
| POS screen | Open sales/POS | Existing POS UI renders. |
| Add items | Add catalog/ad-hoc/manual-priced items supported today | Cart behavior matches web. |
| Complete sale | Submit sale with current payment flows | Backend creates sale and frontend shows current confirmation/feedback. |
| Sale detail | Open an existing sale detail route | Dynamic route `/ventas/[saleId]` works from packaged Next runtime. |

### Reports/dashboard

| Check | Action | Expected result |
| --- | --- | --- |
| Dashboard | Open dashboard | Current dashboard data behavior is preserved. |
| Reports | Open report screens | API-backed sections and currently mocked sections behave as they do in web. |

## Packaged launch

| Check | Action | Expected result |
| --- | --- | --- |
| Unpacked build | Run `pnpm package:dir` | `release/win-unpacked/` is created when Windows symlink privileges are available. |
| Packaged app | Launch `release/win-unpacked/Market Management.exe` | App starts the bundled Next server from `resources/frontend/standalone/server.js`. |
| Installer | Run `pnpm package` | NSIS installer is generated when packaging environment is correctly configured. |

> Windows packaging note: if packaging fails with `Cannot create symbolic link` while extracting `winCodeSign`, enable **Windows Developer Mode** or run the packaging command from an elevated terminal. This is an Electron Builder/Windows privilege issue, not an application build failure.

## Update defaults

Updates are enabled by default through `build/default-config.json`. The renderer must call `updates.check()` → `updates.download()` → `updates.installAndRestart()` explicitly; no automatic download or install is performed.

| Check | Action | Expected result |
| --- | --- | --- |
| Default config | Open `build/default-config.json` | `updates.enabled` is `true`; GitHub provider defaults (`provider`, `owner`, `repo`, `channel`) are present. |
| Runtime config | Call `window.marketDesktop.getConfig()` in DevTools | `updateEnabled` is `true` by default. |
| Update status | Call `window.marketDesktop.updates.getStatus()` | Returns `{ state: "checking-for-update" }` or equivalent enabled status. |
| Check update | Call `window.marketDesktop.updates.check()` | Initiates update check; does not crash. |
| Disable updates | Set `updates.enabled: false` in runtime config | `updateEnabled` becomes `false` and `updates.getStatus()` returns disabled state. |

## Installer build and publish smoke

These checks verify the GitHub Releases publishing pipeline. Publishing requires a `GH_TOKEN` with repository release permissions.

### Local packaging (non-publishing)

| Check | Action | Expected result |
| --- | --- | --- |
| Package (no publish) | Run `pnpm package` | NSIS installer produced; no GitHub release is created. |
| Package dir (no publish) | Run `pnpm package:dir` | `release/win-unpacked/` is created. |
| GH_TOKEN preflight | Run `node scripts/require-gh-token.mjs` without `GH_TOKEN` | Script exits with code 1 and a clear error message. |

### Publishing (requires GH_TOKEN)

| Check | Action | Expected result |
| --- | --- | --- |
| Publish to GitHub | Run `pnpm publish:github` with a valid `GH_TOKEN` | GitHub Release is created with `.exe`, `.blockmap`, and `latest.yml`. |
| Release version | Inspect the GitHub Release | Tag and `latest.yml` version match `package.json` version. |
| Update detection | Install previous version, enable updates, call `updates.check()` | App detects the newer published version. |
| Download | Call `updates.download()` from renderer | Progress events fire; update transitions to `downloaded-pending`. |
| Busy deferral | Start a sale, then call `updates.installAndRestart()` | Status transitions to `blocked-by-busy-state`; app does NOT restart. |
| Idle install | Complete the sale so the app is idle | Deferred install resumes; app restarts with the new version. |

### CI release (GitHub Actions)

These checks verify the tag-triggered CI release pipeline defined in `.github/workflows/release.yml`.

| Check | Action | Expected result |
| --- | --- | --- |
| Tag trigger | Push a `v<package.version>` tag | `Release Desktop` workflow starts on `windows-latest`. |
| Branch push (no trigger) | Push a commit without a tag | Workflow does NOT start. |
| Tag/version mismatch | Push a tag that does not match `package.json` version | Workflow fails at validation step before any build. |
| Workspace layout | Inspect workflow run logs | Desktop checkout at `desktop/`; frontend checkout at `frontend-management-market/supermarket-management-frontend/`; commands run from `desktop/`. |
| Frontend ref pin | Inspect workflow YAML/logs | Frontend checkout uses the committed `FRONTEND_REF` SHA, not a floating branch. |
| Quality gates | Inspect workflow run logs | `pnpm typecheck` and `pnpm test` pass before packaging or publishing. |
| Sibling path resolution | Inspect build step logs | `../frontend-management-market/supermarket-management-frontend` resolves from `desktop/` to the frontend checkout. |
| Release assets | Inspect GitHub Release after successful run | `.exe`, `.exe.blockmap`, and `latest.yml` are present. |
| Manual dispatch absence | Open the Actions workflow UI | No `workflow_dispatch` release trigger is available; retry by re-running the tag workflow. |
| Local fallback | Run `pnpm publish:github` with valid `GH_TOKEN` | Emergency local publish still works. |

### Signing

| Check | Action | Expected result |
| --- | --- | --- |
| Unsigned build | Build without `CSC_LINK` / `CSC_KEY_PASSWORD` | Installer is produced (unsigned). Acceptable for internal validation. |
| Signed build | Build with `CSC_LINK` and `CSC_KEY_PASSWORD` | Installer is signed with the Authenticode certificate. |

> Production deployment requires an EV/OV Authenticode certificate to avoid Windows SmartScreen warnings. Certificate procurement is a deployment follow-up.

## Security sanity checks

| Check | Action | Expected result |
| --- | --- | --- |
| External links | Open an external `https://` link | It opens in the OS browser. |
| Internal navigation | Navigate within the app | It remains inside the Electron window. |
| Node access | Try direct renderer Node access | `require`, filesystem, and process APIs are not directly exposed. |
| Second instance | Launch the app twice | Existing instance is focused. |

## Release readiness notes

- Updates are enabled by default through `build/default-config.json`. Disable updates through runtime config only when the update path is known to be unavailable or misbehaving.
- Do not ship a broad preload API. Only expose explicit allowlisted methods.
- Resolve the Next workspace-root warning later with `turbopack.root` if it becomes noisy or changes build output.
- Backend and frontend behavior must remain independently verifiable outside Electron.
