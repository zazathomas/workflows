import {Locator, Page} from '@playwright/test';

// Page object for ui/src/login/login.tsx. Token login posts to /auth/token;
// the SSO section is out of scope.
export class LoginPage {
    readonly tokenInput: Locator;
    readonly loginButton: Locator;
    readonly logoutButton: Locator;

    constructor(private readonly page: Page) {
        this.tokenInput = page.locator('#login-token');
        this.loginButton = page.getByRole('button', {name: /^Sign in$/});
        this.logoutButton = page.getByRole('button', {name: 'Sign out'});
    }

    async goto(): Promise<void> {
        await this.page.goto('login');
    }

    /** `token` must include the `Bearer ` prefix, exactly as a user would paste it. */
    async loginWithToken(token: string): Promise<void> {
        await this.page.getByRole('button', {name: 'Use a service account token instead'}).click();
        await this.tokenInput.fill(token);
        await this.loginButton.click();
    }

    async logout(): Promise<void> {
        await this.logoutButton.click();
    }
}
