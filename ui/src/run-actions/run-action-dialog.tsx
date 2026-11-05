import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import {PendingRunAction} from '../shared/run-action-monitor';

export function RunActionDialog({action, onClose, onOpen, onViewRun}: {action: PendingRunAction; onClose: () => void; onOpen: () => void; onViewRun: () => void}) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [copyError, setCopyError] = useState(false);
    useEffect(() => {
        dialogRef.current?.querySelector<HTMLAnchorElement>('a[href]')?.focus();
        setCopyError(false);
    }, [action.event.id]);

    const {event, run} = action;
    return (
        <div className='run-action-backdrop'>
            <div
                className='run-action-dialog'
                ref={dialogRef}
                role='dialog'
                aria-modal='true'
                aria-labelledby='run-action-title'
                aria-describedby='run-action-description'
                onKeyDown={keyboard => {
                    if (keyboard.key === 'Escape') {
                        keyboard.preventDefault();
                        onClose();
                    }
                    if (keyboard.key !== 'Tab') return;
                    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || []);
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (keyboard.shiftKey && document.activeElement === first) {
                        keyboard.preventDefault();
                        last.focus();
                    } else if (!keyboard.shiftKey && document.activeElement === last) {
                        keyboard.preventDefault();
                        first.focus();
                    }
                }}>
                <button type='button' className='run-action-dialog__close' aria-label='Close run action' onClick={onClose}>
                    <i className='fa fa-times' aria-hidden='true' />
                </button>
                <h2 id='run-action-title'>{event.title}</h2>
                <p id='run-action-description'>
                    Run {run.namespace}/{run.name} needs an action in your browser.
                </p>
                <p>
                    Check the destination before signing in: <strong>{event.host}</strong>
                </p>
                <p role='note'>Job template editors can choose this sign-in prompt and its code. Only authorize a device request you started and expect.</p>
                {event.code && (
                    <div className='run-action-dialog__code'>
                        <span>One-time code</span>
                        <code>{event.code}</code>
                        <button
                            type='button'
                            onClick={async () => {
                                try {
                                    await navigator.clipboard.writeText(event.code);
                                    setCopyError(false);
                                } catch {
                                    setCopyError(true);
                                }
                            }}>
                            Copy code
                        </button>
                        {copyError && <span role='alert'>Copy unavailable. Select the code above instead.</span>}
                    </div>
                )}
                {event.expiresAt && <p>Expires {new Date(event.expiresAt).toLocaleString()}</p>}
                <div className='run-action-dialog__actions'>
                    <a className='argo-button argo-button--base' href={event.url} target='_blank' rel='noopener noreferrer' onClick={onOpen}>
                        Open {event.host} <i className='fa fa-external-link-alt' aria-hidden='true' />
                    </a>
                    <button type='button' className='argo-button argo-button--base-o' onClick={onViewRun}>
                        View run
                    </button>
                </div>
                <p>Opening the link does not confirm the action. The run keeps updating until it finishes.</p>
            </div>
        </div>
    );
}
