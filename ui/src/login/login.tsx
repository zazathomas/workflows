import * as React from 'react';
import {useState} from 'react';
import {RouteComponentProps} from 'react-router';

import {uiUrl, uiUrlWithParams} from '../shared/base';
import {useCollectEvent} from '../shared/use-collect-event';

import './login.scss';

function getInitialTheme(): 'light' | 'dark' {
    const stored = window.localStorage.getItem('argo-ui-theme');
    if (stored === 'light' || stored === 'dark') {
        return stored;
    }
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
        return 'light';
    }
    return 'dark';
}

export function Login({location}: RouteComponentProps<any>) {
    const urlParams = new URLSearchParams(location.search);
    const redirect = new URLSearchParams({redirect: urlParams.get('redirect') ?? uiUrl('workflows')});
    const [token, setToken] = useState('');
    const [mode, setMode] = useState<'sso' | 'token'>('sso');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    async function signIn() {
        setError('');
        setSubmitting(true);
        try {
            const response = await fetch(uiUrl('auth/token'), {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: token, credentials: 'same-origin'});
            if (!response.ok) throw new Error('Invalid token or client authentication is unavailable.');
            window.location.assign(uiUrl(''));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign in failed.');
        } finally {
            setSubmitting(false);
        }
    }

    async function signOut() {
        setError('');
        try {
            const response = await fetch(uiUrl('auth/logout'), {method: 'POST', credentials: 'same-origin'});
            if (!response.ok) throw new Error('Sign out failed.');
            const {redirect} = await response.json();
            window.location.assign(redirect);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign out failed.');
        }
    }
    const [theme] = useState<'light' | 'dark'>(getInitialTheme);
    useCollectEvent('openedLogin');

    return (
        <div className={`login login--${theme}`}>
            <main className='login__card'>
                <div className='login__brand'>
                    <img className='login__logo' src='assets/images/logo.png' alt='workflows' />
                    <h1 className='login__title'>workflows</h1>
                    <p className='login__subtitle'>Sign in to run and manage jobs.</p>
                </div>

                {mode === 'sso' ? (
                    <section className='login__panel' aria-labelledby='login-sso-heading'>
                        <h2 id='login-sso-heading' className='login__panel-title'>
                            Single sign-on
                        </h2>
                        <p className='login__panel-hint'>Use your organization&apos;s identity provider to continue.</p>
                        <a className='argo-button argo-button--base login__submit' href={uiUrlWithParams('oauth2/redirect', redirect)}>
                            <i className='fa fa-sign-in-alt' aria-hidden='true' /> Sign in with SSO
                        </a>
                        <button type='button' className='login__switch' onClick={() => setMode('token')}>
                            Use a service account token instead
                        </button>
                    </section>
                ) : (
                    <section className='login__panel' aria-labelledby='login-token-heading'>
                        <h2 id='login-token-heading' className='login__panel-title'>
                            Service account token
                        </h2>
                        <p className='login__panel-hint'>Paste a service account token to continue.</p>
                        <label htmlFor='login-token' className='login__label'>
                            Token
                        </label>
                        <textarea id='login-token' className='login__token-input' rows={4} value={token} onChange={event => setToken(event.target.value)} />
                        <button type='button' className='argo-button argo-button--base login__submit' disabled={submitting || !token.trim()} onClick={signIn}>
                            <i className='fa fa-sign-in-alt' aria-hidden='true' /> Sign in
                        </button>
                        <button type='button' className='login__switch' onClick={() => setMode('sso')}>
                            Back to single sign-on
                        </button>
                    </section>
                )}

                {error && <p role='alert'>{error}</p>}
                <div className='login__footer'>
                    <button type='button' className='login__switch' onClick={signOut}>
                        Sign out
                    </button>
                    <span aria-hidden='true'>·</span>
                    <a href='https://argo-workflows.readthedocs.io/en/latest/argo-server-auth-mode/' target='_blank' rel='noreferrer'>
                        Auth modes
                    </a>
                </div>
            </main>
        </div>
    );
}
