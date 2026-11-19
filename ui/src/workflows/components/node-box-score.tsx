import * as React from 'react';

import {uiUrl} from '../../shared/base';
import {formatDuration} from '../../shared/duration';
import {NODE_PHASE, NodePhase, NodeStatus, Workflow} from '../../shared/models';

import './node-box-score.scss';

/**
 * Rundeck-style \"box score\": step counts by status, shown as compact tiles on
 * the run summary. Skipped and omitted steps are grouped as they are both
 * non-executions.
 */
export function countNodesByPhase(nodes?: {[id: string]: NodeStatus}): {phase: NodePhase; count: number}[] {
    const order: NodePhase[] = ['Succeeded', 'Running', 'Failed', 'Error', 'Pending', 'Skipped', 'Omitted'];
    const counts = new Map<NodePhase, number>();
    Object.values(nodes || {}).forEach(node => {
        if (!node.phase) {
            return;
        }
        counts.set(node.phase, (counts.get(node.phase) || 0) + 1);
    });
    return order.filter(phase => counts.has(phase)).map(phase => ({phase, count: counts.get(phase)}));
}

const LABELS: Record<string, string> = {
    Succeeded: 'Complete',
    Running: 'Running',
    Failed: 'Failed',
    Error: 'Errored',
    Pending: 'Pending',
    Skipped: 'Skipped',
    Omitted: 'Omitted'
};

export function NodeBoxScore({workflow}: {workflow: Workflow}) {
    const counts = countNodesByPhase(workflow.status?.nodes);
    if (counts.length === 0) {
        return null;
    }
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    return (
        <div className='node-box-score' role='group' aria-label={`Steps by status, ${total} total`}>
            <div className='node-box-score__tiles'>
                {counts.map(({phase, count}) => (
                    <span key={phase} className={`node-box-score__tile node-box-score__tile--${phase.toLowerCase()}`} title={`${LABELS[phase] || phase} steps`}>
                        <span className='node-box-score__count'>{count}</span>
                        <span className='node-box-score__label'>{LABELS[phase] || phase}</span>
                    </span>
                ))}
            </div>
            <span className='node-box-score__total'>{total} steps</span>
        </div>
    );
}

/**
 * \"Now running\" line: links to the steps that are currently executing
 * (Rundeck pattern), deep-linking the graph node panel with its logs.
 */
export function NowRunningNodes({workflow}: {workflow: Workflow}) {
    const running = Object.values(workflow.status?.nodes || {}).filter(node => node.phase === NODE_PHASE.RUNNING);
    if (running.length === 0) {
        return null;
    }
    return (
        <div className='node-box-score now-running'>
            <span className='now-running__label'>
                <i className='fa fa-play-circle' aria-hidden='true' /> Now running:
            </span>
            {running.slice(0, 5).map((node, index) => (
                <React.Fragment key={node.id}>
                    {index > 0 && ', '}
                    <a
                        className='now-running__node'
                        href={uiUrl(`workflows/${workflow.metadata.namespace}/${workflow.metadata.name}?tab=workflow&nodeId=${node.id}&nodePanelView=logs`)}>
                        {node.displayName || node.name}
                    </a>
                </React.Fragment>
            ))}
            {running.length > 5 && <span> and {running.length - 5} more</span>}
        </div>
    );
}

export function formatBoxScoreDuration(seconds: number): string {
    return formatDuration(seconds);
}
