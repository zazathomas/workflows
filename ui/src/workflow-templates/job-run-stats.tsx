import * as React from 'react';

import {formatDuration, wfDuration} from '../shared/duration';
import {NODE_PHASE, Workflow, WorkflowPhase} from '../shared/models';

import './job-run-stats.scss';

export interface JobStats {
    total: number;
    successRate?: number;
    averageDuration?: number;
    lastStatus?: WorkflowPhase;
}

/** Rundeck-style job stats computed from the job's recent runs. */
export function computeJobStats(workflows: Workflow[]): JobStats {
    const runs = workflows || [];
    const finished = runs.filter(wf => wf.status?.finishedAt && [NODE_PHASE.SUCCEEDED, NODE_PHASE.FAILED, NODE_PHASE.ERROR].includes(wf.status.phase));
    const succeeded = finished.filter(wf => wf.status.phase === NODE_PHASE.SUCCEEDED).length;
    const last = [...runs].filter(wf => wf.status?.startedAt).sort((a, b) => new Date(b.status.startedAt).getTime() - new Date(a.status.startedAt).getTime())[0];
    return {
        total: runs.length,
        successRate: finished.length > 0 ? Math.round((succeeded / finished.length) * 100) : undefined,
        averageDuration: finished.length > 0 ? finished.reduce((sum, wf) => sum + wfDuration(wf.status), 0) / finished.length : undefined,
        lastStatus: last?.status?.phase
    };
}

export function JobRunStats({workflows}: {workflows: Workflow[]}) {
    const stats = computeJobStats(workflows);
    if (stats.total === 0) {
        return null;
    }
    return (
        <div className='job-run-stats' role='group' aria-label='Job statistics from recent runs'>
            <span className='job-run-stats__tile'>
                <span className='job-run-stats__value'>{stats.total}</span>
                <span className='job-run-stats__label'>Runs</span>
            </span>
            <span className='job-run-stats__tile'>
                <span className='job-run-stats__value'>{stats.successRate === undefined ? '-' : stats.successRate + '%'}</span>
                <span className='job-run-stats__label'>Success rate</span>
            </span>
            <span className='job-run-stats__tile'>
                <span className='job-run-stats__value'>{stats.averageDuration === undefined ? '-' : formatDuration(stats.averageDuration)}</span>
                <span className='job-run-stats__label'>Avg duration</span>
            </span>
            <span className='job-run-stats__tile'>
                <span className='job-run-stats__value'>{stats.lastStatus || '-'}</span>
                <span className='job-run-stats__label'>Last run</span>
            </span>
        </div>
    );
}
