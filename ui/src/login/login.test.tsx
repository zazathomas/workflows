import {fireEvent, render} from '@testing-library/react';
import {createMemoryHistory, History} from 'history';
import React from 'react';

import {setCookie} from '../shared/cookie';
import {Login} from './login';

jest.mock('../shared/cookie');

describe('Login', () => {
    const LoginWithHistory = (history: History) => <Login history={history} match={null} location={history.location} />;

    beforeEach(() => {
        const base = document.createElement('base');
        base.setAttribute('href', '/');
        document.head.appendChild(base);
    });

    afterEach(() => {
        document.querySelector('base').remove();
    });

    describe('SSO login', () => {
        it('is the default and links to the SSO redirect', () => {
            const {getByRole} = render(LoginWithHistory(createMemoryHistory()));
            expect(getByRole('heading', {name: 'workflows', level: 1})).toBeInTheDocument();
            expect(getByRole('img', {name: 'workflows'})).toBeInTheDocument();
            expect(getByRole('link', {name: /Sign in with SSO/}).getAttribute('href')).toBe('/oauth2/redirect?redirect=%2Fworkflows');
        });

        it('uses the base href', () => {
            document.querySelector('base').setAttribute('href', '/test/');
            const {getByRole} = render(LoginWithHistory(createMemoryHistory()));
            expect(getByRole('link', {name: /Sign in with SSO/}).getAttribute('href')).toBe('/test/oauth2/redirect?redirect=%2Ftest%2Fworkflows');
        });

        it('honours ?redirect', () => {
            const history = createMemoryHistory();
            history.push('/login?redirect=/workflow-templates');
            const {getByRole} = render(LoginWithHistory(history));
            expect(getByRole('link', {name: /Sign in with SSO/}).getAttribute('href')).toBe('/oauth2/redirect?redirect=%2Fworkflow-templates');
        });
    });

    describe('token login', () => {
        it('is reachable via the switch and submits the token', () => {
            const {getByRole, getByText} = render(LoginWithHistory(createMemoryHistory()));

            expect(getByText('Single sign-on')).toBeInTheDocument();
            fireEvent.click(getByRole('button', {name: 'Use a service account token instead'}));

            const signIn = getByRole('link', {name: /^Sign in$/});
            fireEvent.change(getByRole('textbox'), {target: {value: 'test-token'}});
            fireEvent.click(signIn);

            expect(signIn.getAttribute('href')).toBe('/');
            expect(setCookie).toHaveBeenCalledWith('authorization', 'test-token');
        });
    });

    describe('logout', () => {
        it('links to the logout endpoint', () => {
            const {getByRole} = render(LoginWithHistory(createMemoryHistory()));
            expect(getByRole('link', {name: 'Sign out'}).getAttribute('href')).toBe('/auth/logout');
        });

        it('uses the base href', () => {
            document.querySelector('base').setAttribute('href', '/test/');
            const {getByRole} = render(LoginWithHistory(createMemoryHistory()));
            expect(getByRole('link', {name: 'Sign out'}).getAttribute('href')).toBe('/test/auth/logout');
        });
    });
});
