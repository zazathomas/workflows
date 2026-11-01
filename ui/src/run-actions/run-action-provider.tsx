import {History} from 'history';
import * as React from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {uiUrl} from '../shared/base';
import {Workflow} from '../shared/models';
import {RunActionContext} from '../shared/run-action-context';
import {PendingRunAction, RunActionMonitor, TrackedRun} from '../shared/run-action-monitor';
import {services} from '../shared/services';
import {RunActionDialog} from './run-action-dialog';

import './run-action-provider.scss';

const actionKey = ({run, event}: PendingRunAction) => `${run.uid}:${event.id}`;

export function RunActionProvider({subject, history, children}: {subject?: string; history: History; children: React.ReactNode}) {
    const monitorRef = useRef<RunActionMonitor | null>(null);
    const [tracked, setTracked] = useState<TrackedRun[]>([]);
    const [queued, setQueued] = useState(0);
    const [actions, setActions] = useState<PendingRunAction[]>([]);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const [openKey, setOpenKey] = useState<string | null>(null);
    const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
    const [policyWarning, setPolicyWarning] = useState<string>();
    const [monitorWarnings, setMonitorWarnings] = useState<Record<string, string>>({});
    const [onLogin, setOnLogin] = useState(() => history.location.pathname === uiUrl('login'));
    const indicatorRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const unlisten = history.listen(location => {
            const login = location.pathname === uiUrl('login');
            setOnLogin(login);
            if (login) {
                monitorRef.current?.stop(true);
                setActions([]);
                setDismissed(new Set());
                setOpenKey(null);
                setMonitorWarnings({});
            }
        });
        return unlisten;
    }, [history]);

    useEffect(() => {
        if (!subject || onLogin) return;
        let disposed = false;
        let loading = false;
        let retry: ReturnType<typeof setTimeout>;
        setActions([]);
        setDismissed(new Set());
        setOpenKey(null);
        const monitor = new RunActionMonitor(
            subject,
            action => setActions(previous => (previous.some(existing => actionKey(existing) === actionKey(action)) ? previous : [...previous, action])),
            uid => {
                setActions(previous => previous.filter(action => action.run.uid !== uid));
                setOpenKey(current => (current?.startsWith(uid + ':') ? null : current));
            },
            (uid, message) => {
                setMonitorWarnings(previous => {
                    const current = {...previous};
                    if (message) current[uid] = message;
                    else delete current[uid];
                    return current;
                });
            },
            (runs, waiting) => {
                setTracked(runs);
                setQueued(waiting);
            }
        );
        monitorRef.current = monitor;
        monitor.start();
        async function fetchPolicy() {
            if (disposed || loading) return;
            loading = true;
            try {
                const hosts = await services.runActions.allowedHosts();
                if (disposed) return;
                setAllowedHosts(hosts);
                monitor.setPolicy(hosts);
                setPolicyWarning(hosts.length ? undefined : 'Run action links are disabled. Ask an administrator to configure approved sign-in hosts.');
            } catch {
                if (!disposed) {
                    setAllowedHosts([]);
                    monitor.setPolicy([]);
                    setPolicyWarning('Unable to load the run action host policy. Action links are unavailable until it reconnects.');
                    retry = setTimeout(fetchPolicy, 5000);
                }
            } finally {
                loading = false;
            }
        }
        fetchPolicy();
        const refresh = setInterval(fetchPolicy, 60000);
        return () => {
            disposed = true;
            clearInterval(refresh);
            clearTimeout(retry);
            monitor.stop();
            if (monitorRef.current === monitor) monitorRef.current = null;
        };
    }, [subject, onLogin]);

    useEffect(() => {
        if (!actions.some(action => action.event.expiresAt)) return;
        const expire = setInterval(() => {
            setActions(previous => {
                const current = previous.filter(action => !action.event.expiresAt || Date.parse(action.event.expiresAt) > Date.now());
                return current.length === previous.length ? previous : current;
            });
        }, 1000);
        return () => clearInterval(expire);
    }, [actions]);

    useEffect(() => {
        setActions(previous => {
            const current = previous.filter(action => allowedHosts.includes(action.event.host));
            return current.length === previous.length ? previous : current;
        });
    }, [allowedHosts]);

    useEffect(() => {
        if (openKey && actions.some(action => actionKey(action) === openKey)) return;
        const next = actions.find(action => !dismissed.has(actionKey(action)));
        setOpenKey(next ? actionKey(next) : null);
    }, [actions, dismissed, openKey]);

    const track = useCallback((workflow: Workflow) => {
        if (!monitorRef.current?.track(workflow)) {
            setMonitorWarnings(previous => ({
                ...previous,
                [workflow.metadata.uid || 'current']: 'This run started, but action monitoring could not begin. Open its Logs panel to find the sign-in link.'
            }));
        }
    }, []);
    const contextValue = useMemo(() => ({track}), [track]);
    const warning = Object.values(monitorWarnings)[0] || policyWarning;
    const current = actions.find(action => actionKey(action) === openKey);
    const dismiss = (action: PendingRunAction) => {
        const key = actionKey(action);
        setDismissed(previous => new Set(previous).add(key));
        setOpenKey(currentKey => (currentKey === key ? null : currentKey));
        indicatorRef.current?.focus();
    };
    // Cancelling drops the request instead of only hiding the dialog, so it no
    // longer counts towards the indicator. The run stays monitored: a renewed
    // code arrives with a new event id.
    const cancel = (action: PendingRunAction) => {
        const key = actionKey(action);
        setActions(previous => previous.filter(existing => actionKey(existing) !== key));
        setOpenKey(currentKey => (currentKey === key ? null : currentKey));
        indicatorRef.current?.focus();
    };
    const close = () => {
        if (!current) return;
        dismiss(current);
    };
    const viewRun = () => {
        if (!current) return;
        const {namespace, name} = current.run;
        close();
        history.push(uiUrl(`workflows/${namespace}/${name}?tab=summary`));
    };
    const open = () => {
        if (!current) return;
        const {namespace, name} = current.run;
        close();
        // Let the browser open the external link before React changes the page.
        setTimeout(() => history.push(uiUrl(`workflows/${namespace}/${name}?tab=summary`)), 0);
    };

    return (
        <RunActionContext.Provider value={contextValue}>
            {children}
            {!onLogin && subject && (actions.length > 0 || (tracked.length > 0 && (warning || queued > 0))) && (
                <aside className='run-action-indicator' aria-label='Run actions' role='status'>
                    {actions.length > 0 && (
                        <>
                            <div className='run-action-indicator__header'>
                                <button ref={indicatorRef} type='button' onClick={() => setOpenKey(actionKey(actions[0]))}>
                                    Action required ({actions.length})
                                </button>
                                <button type='button' className='run-action-indicator__cancel' onClick={() => cancel(actions[0])}>
                                    Cancel{actions.length > 1 ? ' first' : ''}
                                </button>
                            </div>
                            {actions.length > 1 && (
                                <ul>
                                    {actions.map(action => (
                                        <li key={actionKey(action)}>
                                            <button type='button' onClick={() => setOpenKey(actionKey(action))}>
                                                {action.event.title} ({action.run.name})
                                            </button>
                                            <button
                                                type='button'
                                                className='run-action-indicator__cancel'
                                                aria-label={`Cancel request for ${action.run.name}`}
                                                onClick={() => cancel(action)}>
                                                Cancel
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                    {warning && <p>{warning}</p>}
                    {queued > 0 && allowedHosts.length > 0 && (
                        <p>
                            {queued} run{queued === 1 ? '' : 's'} waiting for a monitoring slot. Open their Logs panel if a sign-in link is urgent.
                        </p>
                    )}
                </aside>
            )}
            {!onLogin && current && allowedHosts.includes(current.event.host) && <RunActionDialog action={current} onClose={close} onOpen={open} onViewRun={viewRun} />}
        </RunActionContext.Provider>
    );
}
