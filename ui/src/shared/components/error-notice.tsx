import * as React from 'react';
import {CSSProperties, useEffect, useState} from 'react';

import {Notice} from './notice';

import './error-notice.scss';

import {PhaseIcon} from './phase-icon';

// Display an error notice.
// If the error was a HTTP error (i.e. from super-agent), rather than just an unhelpful "Internal Server Error",
// it will display any message in the body.
export function ErrorNotice(props: {style?: CSSProperties; error: Error & {response?: {body: {message?: string}}}; onReload?: () => void; reloadAfterSeconds?: number}) {
    if (!props.error) {
        return null;
    }
    const [error, setError] = useState(() => props.error); // allow us to close the error panel - in case it does not get automatically closed

    useEffect(() => {
        setError(props.error);
    }, [props.error]);

    // This timer code is based on https://stackoverflow.com/questions/57137094/implementing-a-countdown-timer-in-react-with-hooks
    const reloadAfterSeconds = props.reloadAfterSeconds || 120;
    const reload = props.onReload;
    const [timeLeft, setTimeLeft] = useState(reloadAfterSeconds);
    // we cannot automatically call `document.location.reload`
    if (reload) {
        useEffect(() => {
            if (!error) {
                return;
            }
            if (!timeLeft) {
                reload();
                setTimeLeft(reloadAfterSeconds);
            }
            const intervalId = setInterval(() => {
                setTimeLeft(timeLeft - 1);
            }, 1000);
            return () => clearInterval(intervalId);
        }, [timeLeft, error]);
    }
    if (!error) {
        return null;
    }
    const fullMessage = error.message || 'Unknown error. Open your browser error console for more information.';
    const bodyMessage = error.response?.body?.message;
    const details = [fullMessage, bodyMessage ? `Server response: ${bodyMessage}` : ''].filter(Boolean).join('\n\n');
    const firstLine = fullMessage.split('\n')[0];
    const concise = firstLine.includes('?') ? firstLine.slice(0, firstLine.indexOf('?')) : firstLine;
    const summaryText = bodyMessage && !concise.includes(bodyMessage) ? `${concise}: ${bodyMessage}` : concise;
    const summary = summaryText.length > 140 ? `${summaryText.slice(0, 137)}...` : summaryText;
    return (
        <Notice style={{...props.style, padding: 16, margin: '16px 20px'}}>
            <div className='argo-error-notice'>
                <div className='argo-error-notice__summary'>
                    <span role='alert'>
                        <PhaseIcon value='Error' /> {summary}
                    </span>
                    <span className='argo-error-notice__actions'>
                        <button type='button' className='argo-error-notice__action' onClick={() => (reload ? reload() : window.location.reload())}>
                            <i className='fa fa-redo' aria-hidden='true' /> Retry
                        </button>
                        {reload && <span>{timeLeft}s</span>}
                        <button type='button' className='argo-error-notice__close' aria-label='Dismiss error' onClick={() => setError(null)}>
                            <i className='fa fa-times' aria-hidden='true' />
                        </button>
                    </span>
                </div>
                <details className='argo-error-notice__details'>
                    <summary>Technical details</summary>
                    <pre>{details}</pre>
                </details>
            </div>
        </Notice>
    );
}
