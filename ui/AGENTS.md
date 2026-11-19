# UI

React 18 + TypeScript, webpack, rxjs observables (no Redux), `argo-ui` component library pinned to a git SHA. Feature areas map 1:1 to `src/` directories; API clients live in `src/shared/services`. `src/shared/pod-name.ts` must stay in sync with the controller's pod naming.

- Styling: every colour, radius, shadow, type size, space step and duration is a CSS custom property in `src/shared/theme-tokens.scss`, which also overrides the argo-ui elements the shell re-skins. Read `DESIGN.md` before changing a stylesheet; component `.scss` files hold layout and read `var(--token)`, and theming never uses per-component `.theme-dark` blocks.

- Dev server: `yarn start` (:8080) proxies API and artifact routes to an existing argo-server on :2746.
- Tests: `yarn test` (Jest). Mock-backed E2E: `yarn playwright test -c playwright.mock.config.ts`, which starts the UI dev server itself unless `ARGO_UI_BASE_URL` points at one. Live E2E tests mutate resources and require a disposable installation.
- Lint: `yarn lint` (eslint `--fix` on `src` and `e2e`, then `tsc --noEmit` for both the app and `e2e/tsconfig.json`) — commit what `--fix` changes.
- Never install Node/Yarn or browsers on the host — the toolchain runs in containers (rule in the root `AGENTS.md`). Install once with
  `docker run --rm -v "$PWD":/src -v workflows-ui-nm:/src/ui/node_modules -w /src node:24-alpine sh -c "apk add git && yarn --cwd ui install --frozen-lockfile"`
  (the `workflows-ui-nm` volume persists `node_modules`), then run any `yarn` script with that image and mounts plus `-w /src/ui`. For the mock E2E suite from containers, start the dev server as a container on a docker network (`yarn start --host 0.0.0.0 --allowed-hosts all`, add `ARGO_UI_SECURE=true` for https so browser APIs need a secure context) and run Playwright from `mcr.microsoft.com/playwright:v1.64.0` (match the `@playwright/test` version) with `ARGO_UI_BASE_URL=http://<dev-container>:8080`; setting `ARGO_UI_BASE_URL` is what stops Playwright from starting its own server.
- The production bundle is embedded into the server binary via `ui/embed.go`.
