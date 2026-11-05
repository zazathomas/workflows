import {Subscription} from 'rxjs';

import {Workflow} from './models';
import {getPodName} from './pod-name';
import {RetryWatch} from './retry-watch';
import {ACTION_CONTAINER_ANNOTATION, ACTION_MARKER_ANNOTATION, configFromAnnotations, parseRunActionLine, RunActionEvent} from './run-actions';
import {services} from './services';

export interface TrackedRun {
    uid: string;
    namespace: string;
    name: string;
    marker: string;
    container: string;
}

export interface PendingRunAction {
    run: TrackedRun;
    event: RunActionEvent;
}

interface ActiveRun {
    run: TrackedRun;
    watch?: RetryWatch<Workflow>;
    logs?: Subscription;
    timer?: ReturnType<typeof setTimeout>;
    retries: number;
    failures: number;
    reportedError: boolean;
    podName?: string;
}

const MAX_ACTIVE = 2;
const MAX_TRACKED = 20;
const TERMINAL_PHASES = ['Succeeded', 'Failed', 'Error'];

function singlePodName(workflow: Workflow): string | undefined {
    const pods = Object.values(workflow.status?.nodes || {}).filter(node => node.type === 'Pod');
    return pods.length === 1 ? getPodName(workflow, pods[0]) : undefined;
}

function finished(workflow: Workflow) {
    return !!workflow.status?.finishedAt || TERMINAL_PHASES.includes(workflow.status?.phase);
}

function validRun(value: any): value is TrackedRun {
    return (
        value &&
        typeof value.uid === 'string' &&
        value.uid.length > 0 &&
        value.uid.length <= 128 &&
        typeof value.namespace === 'string' &&
        value.namespace.length > 0 &&
        value.namespace.length <= 63 &&
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        value.name.length <= 253 &&
        typeof value.marker === 'string' &&
        typeof value.container === 'string' &&
        !!configFromAnnotations({[ACTION_MARKER_ANNOTATION]: value.marker, [ACTION_CONTAINER_ANNOTATION]: value.container})
    );
}

// A tab owns its monitors. Session storage contains only workflow identity and
// the log marker, never device codes, links, or other pod output.
export class RunActionMonitor {
    private readonly key: string;
    private readonly tracked = new Map<string, TrackedRun>();
    private readonly active = new Map<string, ActiveRun>();
    private readonly seen = new Map<string, Set<string>>();
    private allowedHosts: string[] = [];
    private policyLoaded = false;
    private started = false;

    constructor(
        subject: string,
        private readonly onAction: (action: PendingRunAction) => void,
        private readonly onFinish: (uid: string) => void,
        private readonly onError: (uid: string, message: string) => void,
        private readonly onChange: (tracked: TrackedRun[], queued: number) => void
    ) {
        // Keep this persisted key stable across display-name changes.
        this.key = `workflows-ui.run-actions.v1.${encodeURIComponent(subject)}`;
        try {
            const stored = JSON.parse(sessionStorage.getItem(this.key) || '[]');
            if (Array.isArray(stored)) {
                for (const item of stored.slice(0, MAX_TRACKED)) {
                    if (validRun(item)) this.tracked.set(item.uid, item);
                }
            }
        } catch {
            // Private browsing may disallow storage. Monitoring still works while the tab is open.
        }
    }

    start() {
        this.started = true;
        this.notifyChange();
        this.pump();
    }

    setPolicy(hosts: string[]) {
        const changed = hosts.length !== this.allowedHosts.length || hosts.some((host, index) => host !== this.allowedHosts[index]);
        this.allowedHosts = hosts;
        this.policyLoaded = true;
        if (changed) {
            for (const entry of this.active.values()) this.close(entry);
            this.active.clear();
            this.seen.clear();
        }
        this.pump();
    }

    track(workflow: Workflow): boolean {
        const config = configFromAnnotations(workflow.metadata.annotations);
        const uid = workflow.metadata.uid;
        if (!config || !uid || !workflow.metadata.name || !workflow.metadata.namespace) return false;
        if (!this.tracked.has(uid) && this.tracked.size >= MAX_TRACKED) {
            this.onError(uid, 'Too many active runs to monitor for actions. Open the new run’s logs instead.');
            return false;
        }
        this.tracked.set(uid, {uid, namespace: workflow.metadata.namespace, name: workflow.metadata.name, ...config});
        this.onError(uid, '');
        this.persist();
        this.notifyChange();
        this.pump();
        return true;
    }

    stop(clear = false) {
        this.started = false;
        for (const entry of this.active.values()) this.close(entry);
        this.active.clear();
        if (clear) {
            this.tracked.clear();
            this.seen.clear();
            this.persist();
            this.notifyChange();
        }
    }

    private notifyChange() {
        this.onChange([...this.tracked.values()], Math.max(0, this.tracked.size - this.active.size));
    }

    private persist() {
        try {
            sessionStorage.setItem(this.key, JSON.stringify([...this.tracked.values()]));
        } catch {
            this.onError('storage', 'Browser storage is unavailable. Run actions cannot be restored after a reload.');
        }
    }

    private close(entry: ActiveRun) {
        entry.watch?.stop();
        entry.logs?.unsubscribe();
        if (entry.timer) clearTimeout(entry.timer);
    }

    private remove(uid: string) {
        const entry = this.active.get(uid);
        if (entry) this.close(entry);
        this.active.delete(uid);
        this.tracked.delete(uid);
        this.seen.delete(uid);
        this.persist();
        this.onError(uid, '');
        this.onFinish(uid);
        this.notifyChange();
        this.pump();
    }

    private pump() {
        if (!this.started || !this.policyLoaded || this.allowedHosts.length === 0) {
            this.notifyChange();
            return;
        }
        for (const run of this.tracked.values()) {
            if (this.active.size >= MAX_ACTIVE) break;
            if (this.active.has(run.uid)) continue;
            const entry: ActiveRun = {run, retries: 0, failures: 0, reportedError: false};
            this.active.set(run.uid, entry);
            this.load(entry);
        }
        this.notifyChange();
    }

    private load(entry: ActiveRun) {
        const {run} = entry;
        services.workflows.get(run.namespace, run.name).then(
            workflow => {
                if (this.active.get(run.uid) !== entry) return;
                if (workflow.metadata.uid !== run.uid || finished(workflow)) {
                    this.remove(run.uid);
                    return;
                }
                entry.retries = 0;
                entry.podName = singlePodName(workflow);
                entry.watch = new RetryWatch<Workflow>(
                    () => services.workflows.watch({namespace: run.namespace, name: run.name}),
                    () => undefined,
                    e => {
                        if (e.object?.metadata.uid !== run.uid || e.type === 'DELETED' || finished(e.object)) this.remove(run.uid);
                        else if (this.active.get(run.uid) === entry && entry.podName !== singlePodName(e.object)) {
                            entry.podName = singlePodName(e.object);
                            this.openLogs(entry);
                        }
                    },
                    () => {
                        // A dropped watch must not leave a completed run streaming logs.
                        services.workflows
                            .get(run.namespace, run.name)
                            .then(wf => {
                                if (this.active.get(run.uid) === entry && (wf.metadata.uid !== run.uid || finished(wf))) this.remove(run.uid);
                            })
                            .catch(() => this.report(entry, 'Unable to follow run status. Check workflow access.'));
                    }
                );
                entry.watch.start();
                if (this.active.get(run.uid) === entry) this.openLogs(entry);
            },
            () => {
                this.report(entry, 'Unable to load the run. Check workflow access.');
                this.retry(entry, () => this.load(entry));
            }
        );
    }

    private openLogs(entry: ActiveRun) {
        const {run} = entry;
        entry.logs?.unsubscribe();
        entry.logs = services.workflows.watchRunActionLogs(run.namespace, run.name, run.marker, run.container, entry.podName).subscribe({
            next: log => {
                if (!log) {
                    // The stream is open, so any earlier warning was transient.
                    entry.failures = 0;
                    if (entry.reportedError) {
                        entry.reportedError = false;
                        this.onError(run.uid, '');
                    }
                    return;
                }
                entry.failures = 0;
                const event = parseRunActionLine(log.content, run.marker, this.allowedHosts);
                if (!event) {
                    this.report(entry, 'A marked log line was ignored (invalid, expired, or unapproved link). Check the Job and approved hosts.');
                    return;
                }
                const seen = this.seen.get(run.uid) || new Set<string>();
                if (seen.has(event.id)) return;
                if (seen.size >= 128) {
                    this.report(entry, 'Too many action requests from this run. Open its logs to inspect further requests.');
                    return;
                }
                seen.add(event.id);
                this.seen.set(run.uid, seen);
                entry.retries = 0;
                if (entry.reportedError) {
                    entry.reportedError = false;
                    this.onError(run.uid, '');
                }
                this.onAction({run, event});
            },
            error: () => {
                entry.failures++;
                // A new pod has no logs for a few seconds; only warn once retries
                // have also failed, so submitting does not look like a permission error.
                if (entry.failures >= 3) {
                    this.report(entry, 'Waiting for the run’s logs. Check pod-log access or open Logs on the run if this persists.');
                }
                this.retry(entry, () => this.openLogs(entry));
            },
            complete: () => {
                // A finished pod can close the log stream before the workflow watch
                // reports completion. Refresh before deciding whether to reconnect.
                services.workflows
                    .get(run.namespace, run.name)
                    .then(wf => {
                        if (this.active.get(run.uid) !== entry) return;
                        if (wf.metadata.uid !== run.uid || finished(wf)) this.remove(run.uid);
                        else this.retry(entry, () => this.openLogs(entry));
                    })
                    .catch(() => this.retry(entry, () => this.openLogs(entry)));
            }
        });
    }

    private retry(entry: ActiveRun, callback: () => void) {
        if (this.active.get(entry.run.uid) !== entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        const delay = Math.min(30000, 1000 * 2 ** Math.min(entry.retries++, 5));
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (this.active.get(entry.run.uid) === entry) callback();
        }, delay);
    }

    private report(entry: ActiveRun, message: string) {
        if (this.active.get(entry.run.uid) !== entry || entry.reportedError) return;
        entry.reportedError = true;
        this.onError(entry.run.uid, `${entry.run.namespace}/${entry.run.name}: ${message}`);
    }
}
