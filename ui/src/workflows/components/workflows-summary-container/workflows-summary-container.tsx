import * as React from 'react';

import {Tooltip} from '../../../shared/components/tooltip';
import {Workflow, WorkflowPhase} from '../../../shared/models';

import './workflows-summary-container.scss';

type ReduceReturnType = Record<string, number>;

export function WorkflowsSummaryContainer(props: {workflows: Workflow[]; selectedPhases?: WorkflowPhase[]; onSelectPhase?: (phase: WorkflowPhase) => void}) {
    const wfSummary = (props.workflows || []).reduce<ReduceReturnType>((summary, workflow) => {
        const phase = workflow.status.phase;
        summary[phase] = (summary[phase] || 0) + 1;
        return summary;
    }, {});

    const phases: Array<{name: WorkflowPhase; className: string}> = [
        {name: 'Running', className: 'running'},
        {name: 'Pending', className: 'pending'},
        {name: 'Succeeded', className: 'succeeded'},
        {name: 'Failed', className: 'failed'},
        {name: 'Error', className: 'error'}
    ];

    return (
        <section className='wf-summary-container' aria-labelledby='workflow-summary-heading'>
            <h2 id='workflow-summary-heading' className='wf-summary-container__title'>
                Runs summary{' '}
                <Tooltip content='Only runs in view are summarized'>
                    <span tabIndex={0} aria-label='Only runs in view are summarized'>
                        <i className='fa fa-info-circle' aria-hidden='true' />
                    </span>
                </Tooltip>
            </h2>
            <div className='wf-summary-container__metrics' role='group' aria-label='Run counts by phase'>
                {phases.map(phase => {
                    const count = wfSummary[phase.name] || 0;
                    const selected = (props.selectedPhases || []).includes(phase.name);
                    return (
                        <button
                            key={phase.name}
                            type='button'
                            className={`wf-summary-container__metric wf-summary-container__metric--${phase.className}${selected ? ' wf-summary-container__metric--active' : ''}`}
                            onClick={() => props.onSelectPhase?.(phase.name)}
                            aria-pressed={selected}
                            aria-label={`${phase.name}: ${count}. ${selected ? 'Clear filter' : 'Filter to ' + phase.name}`}>
                            <span className='wf-summary-container__phase'>{phase.name}</span>
                            <strong className='wf-summary-container__value'>{count}</strong>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
