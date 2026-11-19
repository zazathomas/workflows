import {Ticker} from 'argo-ui/src/components/ticker';
import * as React from 'react';

import {ANNOTATION_RUN_MESSAGE} from '../../shared/annotations';
import {uiUrl} from '../../shared/base';
import {DurationPanel} from '../../shared/components/duration-panel';
import {Phase} from '../../shared/components/phase';
import {Timestamp} from '../../shared/components/timestamp';
import {ConditionsPanel} from '../../shared/conditions-panel';
import {Consumer} from '../../shared/context';
import {wfDuration} from '../../shared/duration';
import {labels, NODE_PHASE, SynchronizationStatus, Workflow} from '../../shared/models';
import {ResourcesDuration} from '../../shared/resources-duration';
import {TIMESTAMP_KEYS} from '../../shared/use-timestamp';
import {NodeBoxScore, NowRunningNodes} from './node-box-score';
import {WorkflowCreatorInfo} from './workflow-creator-info/workflow-creator-info';
import {WorkflowElapsedBar} from './workflow-elapsed-bar';
import {WorkflowFrom} from './workflow-from';
import {WorkflowLabels} from './workflow-labels/workflow-labels';
import {WorkflowParametersPanel} from './workflow-parameters-panel';

/** Steps waiting on a semaphore or mutex lock (queue visibility). */
export function QueueSection({workflow}: {workflow: Workflow}) {
    const synchronization: SynchronizationStatus | undefined = workflow.status?.synchronization;
    const waiting: [string, string[]][] = Object.entries(synchronization?.semaphore?.waiting || {}).concat(Object.entries(synchronization?.mutex?.waiting || {}));
    if (waiting.length === 0) {
        return null;
    }
    return (
        <div className='white-box workflow-summary__queue'>
            <h5>
                <i className='fa fa-hourglass-half' aria-hidden='true' /> Queue
            </h5>
            <p>The following steps are waiting for a lock to become available:</p>
            <ul>
                {waiting.map(([nodeId, holders]) => {
                    const node = workflow.status.nodes?.[nodeId];
                    return (
                        <li key={nodeId}>
                            <a href={uiUrl(`workflows/${workflow.metadata.namespace}/${workflow.metadata.name}?tab=workflow&nodeId=${nodeId}`)}>
                                {node?.displayName || node?.name || nodeId}
                            </a>{' '}
                            — {holders.length} {holders.length === 1 ? 'holder' : 'holders'} ahead
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export const WorkflowSummaryPanel = (props: {workflow: Workflow}) => (
    <Ticker disabled={props.workflow && props.workflow.status.phase !== NODE_PHASE.RUNNING}>
        {() => {
            const attributes: {title: string; value: any}[] = [
                {title: 'Status', value: <Phase value={props.workflow.status.phase} />},
                ...(props.workflow.status.message?.trim() ? [{title: 'Message', value: props.workflow.status.message}] : []),
                ...(props.workflow.metadata.annotations?.[ANNOTATION_RUN_MESSAGE]?.trim()
                    ? [{title: 'Run message', value: <em>{props.workflow.metadata.annotations[ANNOTATION_RUN_MESSAGE]}</em>}]
                    : []),
                {title: 'Name', value: props.workflow.metadata.name},
                {title: 'Namespace', value: props.workflow.metadata.namespace},
                {title: 'Started', value: <Timestamp date={props.workflow.status.startedAt} timestampKey={TIMESTAMP_KEYS.WORKFLOW_SUMMARY_PANEL_START} />},
                {title: 'Finished', value: <Timestamp date={props.workflow.status.finishedAt} timestampKey={TIMESTAMP_KEYS.WORKFLOW_SUMMARY_PANEL_END} />},
                {
                    title: 'Duration',
                    value: (
                        <DurationPanel
                            phase={props.workflow.status.phase}
                            duration={wfDuration(props.workflow.status)}
                            estimatedDuration={props.workflow.status.estimatedDuration}
                        />
                    )
                },
                {title: 'Progress', value: props.workflow.status.progress || '-'},
                {title: 'From', value: <WorkflowFrom namespace={props.workflow.metadata.namespace} labels={props.workflow.metadata.labels} />}
            ];
            const detailAttributes: {title: string; value: any}[] = [
                {
                    title: 'Labels',
                    value: (
                        <details>
                            <summary>View labels ({Object.keys(props.workflow.metadata.labels || {}).length})</summary>
                            <Consumer>
                                {ctx => (
                                    <WorkflowLabels
                                        workflow={props.workflow}
                                        onChange={(key, value) => ctx.navigation.goto(uiUrl(`workflows/${props.workflow.metadata.namespace}?label=${key}=${value}`))}
                                    />
                                )}
                            </Consumer>
                        </details>
                    )
                }
            ];
            const creator = props.workflow.metadata.labels?.[labels.creator];
            if (creator) {
                detailAttributes.push({
                    title: 'Creator',
                    value: (
                        <Consumer>
                            {ctx => (
                                <WorkflowCreatorInfo
                                    workflow={props.workflow}
                                    onChange={(key, value) => ctx.navigation.goto(uiUrl(`workflows/${props.workflow.metadata.namespace}?label=${key}=${value}`))}
                                />
                            )}
                        </Consumer>
                    )
                });
            }
            if (props.workflow.status.resourcesDuration) {
                detailAttributes.push({
                    title: 'Resources Duration',
                    value: <ResourcesDuration resourcesDuration={props.workflow.status.resourcesDuration} />
                });
            }
            if (props.workflow.status.conditions) {
                detailAttributes.push({
                    title: 'Conditions',
                    value: <ConditionsPanel conditions={props.workflow.status.conditions} />
                });
            }
            return (
                <>
                    <NodeBoxScore workflow={props.workflow} />
                    <WorkflowElapsedBar workflow={props.workflow} />
                    <NowRunningNodes workflow={props.workflow} />
                    <div className='white-box'>
                        <div className='white-box__details'>
                            {attributes.map(attr => (
                                <div className='row white-box__details-row' key={attr.title}>
                                    <div className='columns small-3'>{attr.title}</div>
                                    <div className='columns small-9'>{attr.value}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <QueueSection workflow={props.workflow} />
                    {props.workflow.spec.arguments?.parameters && (
                        <section className='workflow-details__section' aria-labelledby='workflow-parameters-heading'>
                            <h5 id='workflow-parameters-heading'>Parameters</h5>
                            <WorkflowParametersPanel parameters={props.workflow.spec.arguments.parameters} />
                        </section>
                    )}
                    <section className='workflow-details__section' aria-labelledby='workflow-details-heading'>
                        <details className='workflow-summary__details'>
                            <summary>
                                <h5 id='workflow-details-heading'>Workflow Details</h5>
                            </summary>
                            <div className='white-box'>
                                <div className='white-box__details'>
                                    {detailAttributes.map(attr => (
                                        <div className='row white-box__details-row' key={attr.title}>
                                            <div className='columns small-3'>{attr.title}</div>
                                            <div className='columns small-9'>{attr.value}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </details>
                    </section>
                </>
            );
        }}
    </Ticker>
);
