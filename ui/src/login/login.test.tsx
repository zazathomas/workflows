import {fireEvent, render, waitFor} from '@testing-library/react';
import {createMemoryHistory, History} from 'history';
import React from 'react';

import {Login} from './login';

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
        it('posts the token without writing it to a JavaScript cookie', async () => {
            const fetchMock = jest.fn().mockResolvedValue({ok: false});
            global.fetch = fetchMock;
            const {getByRole, getByText} = render(LoginWithHistory(createMemoryHistory()));

            expect(getByText('Single sign-on')).toBeInTheDocument();
            fireEvent.click(getByRole('button', {name: 'Use a service account token instead'}));

            const signIn = getByRole('button', {name: /^Sign in$/});
            fireEvent.change(getByRole('textbox'), {target: {value: 'test-token'}});
            fireEvent.click(signIn);

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith('/auth/token', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: 'test-token', credentials: 'same-origin'})
            );
            expect(getByRole('alert')).toHaveTextContent('Invalid token');
        });
    });

    describe('logout', () => {
        it('posts to the logout endpoint under the base href', async () => {
            const fetchMock = jest.fn().mockResolvedValue({ok: false});
            global.fetch = fetchMock;
            document.querySelector('base').setAttribute('href', '/test/');
            const {getByRole} = render(LoginWithHistory(createMemoryHistory()));
            fireEvent.click(getByRole('button', {name: 'Sign out'}));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/test/auth/logout', {method: 'POST', credentials: 'same-origin'}));
        });
    });
});
