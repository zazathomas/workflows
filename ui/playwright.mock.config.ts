import {defineConfig, devices} from '@playwright/test';

// Isolated browser tests: all API requests are intercepted and no real workflows are created.
export default defineConfig({
    testDir: './e2e/mock',
    timeout: 30000,
    use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.ARGO_UI_BASE_URL || 'http://localhost:8080',
        launchOptions: process.env.PLAYWRIGHT_BROWSER_PATH ? {executablePath: process.env.PLAYWRIGHT_BROWSER_PATH} : undefined,
        trace: 'retain-on-failure'
    },
    reporter: 'list'
});
