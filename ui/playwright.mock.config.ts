import {defineConfig, devices} from '@playwright/test';

// Isolated browser tests: all API requests are intercepted and no real workflows are created.
export default defineConfig({
    testDir: './e2e/mock',
    timeout: 30000,
    // Start the dev server unless the caller pointed the suite at one (the
    // container flow in ui/AGENTS.md runs it as a separate container and sets
    // ARGO_UI_BASE_URL). Locally an already-running server is reused, so
    // `make test-ui-e2e` works either way.
    webServer: process.env.ARGO_UI_BASE_URL
        ? undefined
        : {
              command: 'yarn start',
              url: 'http://localhost:8080',
              reuseExistingServer: !process.env.CI,
              timeout: 240_000
          },
    use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.ARGO_UI_BASE_URL || 'http://localhost:8080',
        // the dev server may run behind a self-signed certificate (ARGO_UI_SECURE),
        // e.g. when this suite runs from a container against a containerized dev server
        ignoreHTTPSErrors: true,
        launchOptions: process.env.PLAYWRIGHT_BROWSER_PATH ? {executablePath: process.env.PLAYWRIGHT_BROWSER_PATH} : undefined,
        trace: 'retain-on-failure'
    },
    reporter: 'list'
});
