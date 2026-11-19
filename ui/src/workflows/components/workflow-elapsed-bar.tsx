import {Ticker} from 'argo-ui/src/components/ticker';
import * as React from 'react';
import {useEffect, useState} from 'react';

import {formatDuration, wfDuration} from '../../shared/duration';
import {labels as labelKeys, NODE_PHASE, Workflow} from '../../shared/models';
import {services} from '../../shared/services';

import './workflow-elapsed-bar.scss';

/**
 * Rundeck-pattern progress bar: the elapsed time of a running Run against the
 * average duration of the Run's previous executions of the same Job. The bar
 * turns orange once the elapsed time exceeds the average.
 */
export function WorkflowElapsedBar({workflow}: {workflow: Workflow}) {
    const [average, setAverage] = useState<{seconds: number; runs: number}>();

    const uid = workflow?.metadata?.uid;
    const phase = workflow?.status?.phase;
    const labels = workflow?.metadata?.labels || {};
    const templateLabelKey = [labelKeys.workflowTemplate, labelKeys.clusterWorkflowTemplate, labelKeys.cronWorkflow].find(key => labels[key]);

    useEffect(() => {
        let disposed = false;
        setAverage(undefined);
        if (!uid || !templateLabelKey || !workflow.metadata.namespace) {
            return;
        }
        services.workflows
            .list(workflow.metadata.namespace, [], [`${templateLabelKey}=${labels[templateLabelKey]}`], {limit: 50})
            .then(list => {
                if (disposed) {
                    return;
                }
                const durations = (list.items || [])
                    .filter(item => item.metadata.uid !== uid && item.status?.startedAt && item.status?.finishedAt)
                    .map(item => wfDuration(item.status));
                if (durations.length === 0) {
                    return;
                }
                setAverage({seconds: durations.reduce((sum, value) => sum + value, 0) / durations.length, runs: durations.length});
            })
            .catch(() => {
                // the average is a nice-to-have; ignore load errors
                if (!disposed) {
                    setAverage(undefined);
                }
            });
        return () => {
            disposed = true;
        };
    }, [uid, templateLabelKey, labels[templateLabelKey], workflow.metadata.namespace]);

    if (phase !== NODE_PHASE.RUNNING || !average || average.seconds <= 0) {
        return null;
    }

    return (
        <div className='workflow-elapsed-bar' role='status' aria-label='Elapsed time against the average duration'>
            <Ticker>
                {() => {
                    const elapsed = wfDuration(workflow.status);
                    const ratio = elapsed / average.seconds;
                    return (
                        <>
                            <div className='workflow-elapsed-bar__track'>
                                <div
                                    className={`workflow-elapsed-bar__fill ${ratio > 1 ? 'workflow-elapsed-bar__fill--over' : ''}`}
                                    style={{width: `${Math.min(100, ratio * 100)}%`}}
                                />
                            </div>
                            <div className='workflow-elapsed-bar__caption'>
                                <span>Elapsed {formatDuration(elapsed)}</span>
                                <span>
                                    {' '}
                                    vs average {formatDuration(average.seconds)} from {average.runs} {average.runs === 1 ? 'run' : 'runs'}
                                    {ratio > 1 ? ' — over the average' : ''}
                                </span>
                            </div>
                        </>
                    );
                }}
            </Ticker>
        </div>
    );
}
