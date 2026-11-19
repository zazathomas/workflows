import * as React from 'react';
import {useEffect, useState} from 'react';

import {NODE_PHASE, Workflow} from '../../shared/models';

import './watch-run-button.scss';

const STORAGE_KEY = 'watch-run-uids';

/**
 * \"Watch this run\": fire a browser notification when a run finishes while it is
 * open. The frontend-only stopgap for job-runner notifications (AWX
 * notification templates / Semaphore alerts need server support).
 */
function watchedUids(): Set<string> {
    try {
        return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
    } catch {
        return new Set();
    }
}

function saveWatchedUids(uids: Set<string>) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(uids)));
    } catch {
        // watching still works for this page when storage is blocked
    }
}

export function isTerminalPhase(phase?: string): boolean {
    return phase === NODE_PHASE.SUCCEEDED || phase === NODE_PHASE.FAILED || phase === NODE_PHASE.ERROR;
}

export function WatchRunButton({workflow}: {workflow: Workflow}) {
    const uid = workflow?.metadata?.uid;
    const [watching, setWatching] = useState(() => !!uid && watchedUids().has(uid));
    const phase = workflow?.status?.phase;

    useEffect(() => {
        if (!uid) {
            return;
        }
        setWatching(watchedUids().has(uid));
    }, [uid]);

    useEffect(() => {
        if (!uid || !watching || !isTerminalPhase(phase)) {
            return;
        }
        const uids = watchedUids();
        if (!uids.has(uid)) {
            return;
        }
        uids.delete(uid);
        saveWatchedUids(uids);
        setWatching(false);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`Run ${workflow.metadata.name} ${phase.toLowerCase()}`, {
                body: workflow.status?.message || `The run finished with status ${phase}.`,
                tag: uid
            });
        }
    }, [uid, watching, phase]);

    async function toggle() {
        if (!uid) {
            return;
        }
        const uids = watchedUids();
        if (watching) {
            uids.delete(uid);
            saveWatchedUids(uids);
            setWatching(false);
            return;
        }
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            try {
                await Notification.requestPermission();
            } catch {
                // ignore: the browser may refuse without user gesture
            }
        }
        if (isTerminalPhase(phase)) {
            return; // nothing to wait for; do not enable the toggle
        }
        uids.add(uid);
        saveWatchedUids(uids);
        setWatching(true);
    }

    return (
        <button
            type='button'
            className={`argo-button argo-button--base-o watch-run-button ${watching ? 'watch-run-button--on' : ''}`}
            onClick={toggle}
            aria-pressed={watching}
            title={watching ? 'Stop notifying me when this run finishes' : 'Notify me when this run finishes'}>
            <i className={`fa ${watching ? 'fa-bell' : 'fa-bell-slash'}`} aria-hidden='true' />
            <span>{watching ? 'Watching' : 'Watch'}</span>
        </button>
    );
}
