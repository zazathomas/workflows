import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';
import {Link, RouteComponentProps} from 'react-router-dom';

import {getCronNextScheduledTime} from '../cron-workflows/cron-workflow-row';
import {uiUrl} from '../shared/base';
import {ErrorNotice} from '../shared/components/error-notice';
import {Loading} from '../shared/components/loading';
import {NamespaceFilter} from '../shared/components/namespace-filter';
import {PhaseIcon} from '../shared/components/phase-icon';
import {Timestamp} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {ago, formatDuration, wfDuration} from '../shared/duration';
import {historyUrl} from '../shared/history';
import {CronWorkflow, labels, NODE_PHASE, Workflow} from '../shared/models';
import * as nsUtils from '../shared/namespaces';
import {services} from '../shared/services';
import {useCollectEvent} from '../shared/use-collect-event';

import './dashboard.scss';

const CHART_DAYS = 14;
const RECENT_RUNS = 8;
const UPCOMING_SCHEDULES = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * AWX-style dashboard: KPI cards, a runs-per-day chart, recent runs, upcoming
 * schedules and a \"needs attention\" strip.
 */
export function Dashboard({match, history}: RouteComponentProps<any>) {
    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [cronWorkflows, setCronWorkflows] = useState<CronWorkflow[]>();
    const [error, setError] = useState<Error>();
    const [next, setNext] = useState<string>();
    const namespaceRef = useRef(namespace);
    namespaceRef.current = namespace;

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        history.push(historyUrl('dashboard' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace}));
    }, [namespace]);

    useEffect(() => {
        let disposed = false;
        setWorkflows(undefined);
        setError(undefined);
        setNext(undefined);
        services.workflows
            .runView(namespace, 'summary')
            .then(list => {
                if (disposed) return;
                setWorkflows(list.items || []);
                setNext(list.metadata?.continue);
                return services.cronWorkflows.list(namespace, []).then(crons => {
                    if (disposed) return;
                    setCronWorkflows(crons || []);
                });
            })
            .catch(err => {
                if (!disposed) setError(err);
            });
        return () => {
            disposed = true;
        };
    }, [namespace]);

    function loadMore(cursor: string) {
        services.workflows
            .runView(namespace, 'summary', cursor)
            .then(list => {
                if (namespaceRef.current !== namespace) return;
                setWorkflows(current => {
                    const rows = new Map((current || []).map(workflow => [workflow.metadata.uid, workflow]));
                    (list.items || []).forEach(workflow => rows.set(workflow.metadata.uid, workflow));
                    return [...rows.values()];
                });
                setNext(list.metadata?.continue);
            })
            .catch(err => {
                if (namespaceRef.current === namespace) setError(err);
            });
    }

    useCollectEvent('openedDashboard');

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekAgo = now.getTime() - 7 * MS_PER_DAY;
    const dayAgo = now.getTime() - MS_PER_DAY;

    const active = (workflows || []).filter(wf => wf.status?.phase === NODE_PHASE.RUNNING);
    const pending = (workflows || []).filter(wf => wf.status?.phase === NODE_PHASE.PENDING);
    const todayRuns = (workflows || []).filter(wf => wf.status?.startedAt && new Date(wf.status.startedAt).getTime() >= startOfToday);
    const finishedLastWeek = (workflows || []).filter(wf => wf.status?.finishedAt && new Date(wf.status.finishedAt).getTime() >= weekAgo);
    const outcomes = finishedLastWeek.filter(wf => wf.status.phase === NODE_PHASE.SUCCEEDED || wf.status.phase === NODE_PHASE.FAILED || wf.status.phase === NODE_PHASE.ERROR);
    const successes = outcomes.filter(wf => wf.status.phase === NODE_PHASE.SUCCEEDED).length;
    const successRate = outcomes.length > 0 ? Math.round((successes / outcomes.length) * 100) : undefined;
    const averageDuration = finishedLastWeek.length > 0 ? finishedLastWeek.reduce((sum, wf) => sum + wfDuration(wf.status), 0) / finishedLastWeek.length : undefined;
    const needsAttention = (workflows || [])
        .filter(
            wf => (wf.status?.phase === NODE_PHASE.FAILED || wf.status?.phase === NODE_PHASE.ERROR) && wf.status?.finishedAt && new Date(wf.status.finishedAt).getTime() >= dayAgo
        )
        .sort((a, b) => new Date(b.status.finishedAt).getTime() - new Date(a.status.finishedAt).getTime());

    const [failedFirst, setFailedFirst] = useState(false);
    const recentRuns = [...(workflows || [])]
        .filter(wf => wf.status?.startedAt)
        .sort((a, b) => new Date(b.status.startedAt).getTime() - new Date(a.status.startedAt).getTime())
        .sort((a, b) => {
            if (!failedFirst) return 0;
            const aFailed = a.status.phase === NODE_PHASE.FAILED || a.status.phase === NODE_PHASE.ERROR ? 1 : 0;
            const bFailed = b.status.phase === NODE_PHASE.FAILED || b.status.phase === NODE_PHASE.ERROR ? 1 : 0;
            return bFailed - aFailed;
        })
        .slice(0, RECENT_RUNS);

    // Most-run Jobs (grouped by the workflow-template label), with the last
    // run's status.
    const jobRuns = new Map<string, {count: number; lastPhase: string; lastFinished: string}>();
    (workflows || []).forEach(wf => {
        const job = wf.metadata.labels?.[labels.workflowTemplate] || wf.metadata.labels?.[labels.clusterWorkflowTemplate];
        if (!job) return;
        const entry = jobRuns.get(job) || {count: 0, lastPhase: '', lastFinished: ''};
        entry.count++;
        if (wf.status?.finishedAt && wf.status.finishedAt > entry.lastFinished) {
            entry.lastFinished = wf.status.finishedAt;
            entry.lastPhase = wf.status.phase || '';
        }
        jobRuns.set(job, entry);
    });
    const mostRunJobs = [...jobRuns.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);

    const upcoming = (cronWorkflows || [])
        .filter(cron => !cron.spec.suspend)
        .map(cron => ({cron, next: getCronNextScheduledTime(cron.spec)}))
        .filter(entry => entry.next)
        .sort((a, b) => a.next.getTime() - b.next.getTime())
        .slice(0, UPCOMING_SCHEDULES);

    return (
        <Page title='Overview' toolbar={{breadcrumbs: [{title: 'Overview', path: uiUrl('dashboard')}]}}>
            <h1 className='modern-visually-hidden'>Overview</h1>
            <div className='dashboard'>
                <div className='dashboard__filters'>
                    <label htmlFor='dashboard-namespace'>Namespace</label>{' '}
                    <NamespaceFilter id='dashboard-namespace' ariaLabel='Dashboard namespace' value={namespace} onChange={setNamespace} />
                </div>
                <ErrorNotice error={error} />
                {!workflows ? (
                    !error && <Loading />
                ) : (
                    <>
                        <p>Totals cover the loaded live workflows. Archived workflows are not included.</p>
                        {next && (
                            <button className='argo-button argo-button--neutral' onClick={() => loadMore(next)}>
                                Load more runs
                            </button>
                        )}
                        <div className='dashboard__kpis'>
                            <div className='dashboard__kpi'>
                                <span className='dashboard__kpi-value'>{active.length}</span>
                                <span className='dashboard__kpi-label'>Running now</span>
                            </div>
                            <div className='dashboard__kpi'>
                                <span className='dashboard__kpi-value'>{pending.length}</span>
                                <span className='dashboard__kpi-label'>Pending</span>
                            </div>
                            <div className='dashboard__kpi'>
                                <span className='dashboard__kpi-value'>{todayRuns.length}</span>
                                <span className='dashboard__kpi-label'>Runs today</span>
                            </div>
                            <div className='dashboard__kpi'>
                                <span className='dashboard__kpi-value'>{successRate === undefined ? '-' : successRate + '%'}</span>
                                <span className='dashboard__kpi-label'>Success (7d)</span>
                            </div>
                            <div className='dashboard__kpi'>
                                <span className='dashboard__kpi-value'>{averageDuration === undefined ? '-' : formatDuration(averageDuration)}</span>
                                <span className='dashboard__kpi-label'>Avg duration (7d)</span>
                            </div>
                        </div>
                        {needsAttention.length > 0 && (
                            <section className='dashboard__attention' aria-label='Needs attention'>
                                <h3>
                                    <i className='fa fa-exclamation-triangle' aria-hidden='true' /> Needs attention
                                </h3>
                                <ul>
                                    {needsAttention.slice(0, 5).map(wf => (
                                        <li key={wf.metadata.uid}>
                                            <PhaseIcon value={wf.status.phase} />{' '}
                                            <Link to={uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}`)}>{wf.metadata.name}</Link>{' '}
                                            <span className='dashboard__muted'>{ago(new Date(wf.status.finishedAt))}</span>
                                        </li>
                                    ))}
                                    {needsAttention.length > 5 && (
                                        <li>
                                            <Link to={uiUrl(`workflows${namespace ? '/' + namespace : ''}?phase=Failed&phase=Error`)}>
                                                and {needsAttention.length - 5} more failed runs
                                            </Link>
                                        </li>
                                    )}
                                </ul>
                            </section>
                        )}
                        <div className='dashboard__grid'>
                            <section className='dashboard__panel' aria-label='Runs per day'>
                                <h3>Runs per day (last {CHART_DAYS} days)</h3>
                                <RunsPerDayChart workflows={workflows || []} />
                            </section>
                            <section className='dashboard__panel' aria-label='Recent runs'>
                                <h3>
                                    Recent runs{' '}
                                    <button
                                        type='button'
                                        className={`argo-button argo-button--base-o dashboard__failed-first ${failedFirst ? 'active' : ''}`}
                                        aria-pressed={failedFirst}
                                        title='Show failed runs first'
                                        onClick={() => setFailedFirst(value => !value)}>
                                        <i className='fa fa-exclamation-triangle' aria-hidden='true' /> Failed first
                                    </button>
                                </h3>
                                {recentRuns.length === 0 ? (
                                    <ZeroState title='No runs yet'>
                                        <p>
                                            <Link to={uiUrl('workflow-templates')}>Run a job</Link> to see it here.
                                        </p>
                                    </ZeroState>
                                ) : (
                                    <ul className='dashboard__runs'>
                                        {recentRuns.map(wf => (
                                            <li key={wf.metadata.uid}>
                                                <PhaseIcon value={wf.status.phase} />{' '}
                                                <Link to={uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}?uid=${wf.metadata.uid}`)}>{wf.metadata.name}</Link>
                                                <span className='dashboard__muted'>{formatDuration(wfDuration(wf.status))}</span>
                                                <span className='dashboard__muted'>
                                                    <Timestamp date={wf.status.startedAt} compact />
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                            <section className='dashboard__panel' aria-label='Most-run jobs'>
                                <h3>Most-run jobs</h3>
                                {mostRunJobs.length === 0 ? (
                                    <p className='dashboard__muted'>No runs of jobs yet.</p>
                                ) : (
                                    <ul className='dashboard__jobs'>
                                        {mostRunJobs.map(([job, stats]) => (
                                            <li key={job}>
                                                <i className='fa fa-window-maximize' aria-hidden='true' />{' '}
                                                <Link to={uiUrl('workflow-templates/' + (namespace || '') + (namespace ? '/' : '') + job)}>{job}</Link>
                                                <span className='dashboard__muted'>{stats.count} runs</span>
                                                {stats.lastPhase && <PhaseIcon value={stats.lastPhase} />}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                            <section className='dashboard__panel' aria-label='Upcoming schedules'>
                                <h3>Upcoming schedules</h3>
                                {upcoming.length === 0 ? (
                                    <p className='dashboard__muted'>No active schedules.</p>
                                ) : (
                                    <ul className='dashboard__schedules'>
                                        {upcoming.map(({cron, next}) => (
                                            <li key={`${cron.metadata.namespace}/${cron.metadata.name}`}>
                                                <i className='fa fa-clock' aria-hidden='true' />{' '}
                                                <Link to={uiUrl(`cron-workflows/${cron.metadata.namespace}/${cron.metadata.name}`)}>{cron.metadata.name}</Link>
                                                <span className='dashboard__muted'>
                                                    <Timestamp date={next} />
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>
                    </>
                )}
            </div>
        </Page>
    );
}

function RunsPerDayChart({workflows}: {workflows: Workflow[]}) {
    const days: {date: Date; succeeded: number; failed: number; other: number}[] = [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    for (let i = CHART_DAYS - 1; i >= 0; i--) {
        days.push({date: new Date(startOfToday.getTime() - i * MS_PER_DAY), succeeded: 0, failed: 0, other: 0});
    }
    workflows.forEach(wf => {
        if (!wf.status?.startedAt) {
            return;
        }
        const started = new Date(wf.status.startedAt);
        const day = days.find(entry => started >= entry.date && started < new Date(entry.date.getTime() + MS_PER_DAY));
        if (!day) {
            return;
        }
        switch (wf.status.phase) {
            case NODE_PHASE.SUCCEEDED:
                day.succeeded++;
                break;
            case NODE_PHASE.FAILED:
            case NODE_PHASE.ERROR:
                day.failed++;
                break;
            default:
                day.other++;
        }
    });
    const max = Math.max(1, ...days.map(day => day.succeeded + day.failed + day.other));
    return (
        <div className='dashboard__chart' role='img' aria-label='Runs per day, successes and failures'>
            {days.map(day => {
                const total = day.succeeded + day.failed + day.other;
                return (
                    <div
                        key={day.date.toISOString()}
                        className='dashboard__chart-column'
                        title={`${day.date.toLocaleDateString()}: ${total} runs (${day.succeeded} succeeded, ${day.failed} failed)`}>
                        <div className='dashboard__chart-bar' style={{height: `${(total / max) * 100}%`}}>
                            <div className='dashboard__chart-failed' style={{flexGrow: day.failed}} />
                            <div className='dashboard__chart-succeeded' style={{flexGrow: day.succeeded}} />
                            <div className='dashboard__chart-other' style={{flexGrow: day.other}} />
                        </div>
                        <span className='dashboard__chart-label'>{day.date.getDate()}</span>
                    </div>
                );
            })}
        </div>
    );
}
