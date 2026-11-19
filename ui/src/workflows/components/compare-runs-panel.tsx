import * as React from 'react';
import {useEffect, useState} from 'react';

import {uiUrl} from '../../shared/base';
import {ErrorNotice} from '../../shared/components/error-notice';
import {Loading} from '../../shared/components/loading';
import {ZeroState} from '../../shared/components/zero-state';
import {formatDuration, wfDuration} from '../../shared/duration';
import {labels as labelKeys, Parameter, Workflow} from '../../shared/models';
import {services} from '../../shared/services';

import './compare-runs-panel.scss';

/**
 * \"Compare with previous run\" (Blue Ocean Changes tab pattern): parameter and
 * outcome diff against the previous run of the same Job.
 */
function parametersByName(workflow: Workflow): Map<string, string> {
    const map = new Map<string, string>();
    (workflow.spec?.arguments?.parameters || []).forEach((parameter: Parameter) => map.set(parameter.name, parameter.value === undefined ? '' : String(parameter.value)));
    return map;
}

export function CompareRunsPanel({workflow}: {workflow: Workflow}) {
    const [previous, setPrevious] = useState<Workflow>();
    const [error, setError] = useState<Error>();
    const [loaded, setLoaded] = useState(false);

    const labels = workflow?.metadata?.labels || {};
    const templateLabelKey = [labelKeys.workflowTemplate, labelKeys.clusterWorkflowTemplate, labelKeys.cronWorkflow].find(key => labels[key]);

    useEffect(() => {
        let disposed = false;
        setLoaded(false);
        setError(undefined);
        setPrevious(undefined);
        if (!templateLabelKey || !workflow.metadata.namespace) {
            setLoaded(true);
            return;
        }
        services.workflows
            .list(workflow.metadata.namespace, [], [`${templateLabelKey}=${labels[templateLabelKey]}`], {limit: 100})
            .then(list => {
                if (disposed) {
                    return;
                }
                const startedAt = workflow.status?.startedAt ? new Date(workflow.status.startedAt).getTime() : Date.now();
                const earlier = (list.items || [])
                    .filter(item => item.metadata.uid !== workflow.metadata.uid)
                    .filter(item => item.status?.startedAt && new Date(item.status.startedAt).getTime() <= startedAt)
                    .sort((a, b) => new Date(b.status.startedAt).getTime() - new Date(a.status.startedAt).getTime());
                setPrevious(earlier[0]);
                setLoaded(true);
            })
            .catch(err => {
                if (!disposed) {
                    setError(err);
                    setLoaded(true);
                }
            });
        return () => {
            disposed = true;
        };
    }, [workflow.metadata.uid]);

    const currentParameters = parametersByName(workflow);

    return (
        <div className='compare-runs-panel'>
            <h4>Compare with previous run</h4>
            {error && <ErrorNotice error={error} />}
            {!loaded ? (
                <Loading />
            ) : !previous ? (
                <ZeroState title='No previous run'>
                    <p>This is the first run recorded for this job, so there is nothing to compare against.</p>
                </ZeroState>
            ) : (
                <>
                    <table className='compare-runs-panel__table'>
                        <thead>
                            <tr>
                                <th />
                                <th>
                                    Previous run{' '}
                                    <a href={uiUrl(`workflows/${previous.metadata.namespace}/${previous.metadata.name}?uid=${previous.metadata.uid}`)}>{previous.metadata.name}</a>
                                </th>
                                <th>This run</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <th>Outcome</th>
                                <td>{previous.status?.phase || '-'}</td>
                                <td>{workflow.status?.phase || '-'}</td>
                            </tr>
                            <tr>
                                <th>Duration</th>
                                <td>{previous.status?.startedAt ? formatDuration(wfDuration(previous.status)) : '-'}</td>
                                <td>{workflow.status?.startedAt ? formatDuration(wfDuration(workflow.status)) : '-'}</td>
                            </tr>
                            {Array.from(new Set([...Array.from(parametersByName(previous).keys()), ...Array.from(currentParameters.keys())])).map(name => {
                                const previousValue = parametersByName(previous).get(name);
                                const currentValue = currentParameters.get(name);
                                const changed = previousValue !== currentValue;
                                return (
                                    <tr key={name} className={changed ? 'compare-runs-panel__changed' : ''}>
                                        <th>{name}</th>
                                        <td>{previousValue === undefined ? <em>not set</em> : previousValue}</td>
                                        <td>{currentValue === undefined ? <em>not set</em> : currentValue}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <p className='compare-runs-panel__hint'>Changed parameters are highlighted. Comparisons use the job label on both runs.</p>
                </>
            )}
        </div>
    );
}
