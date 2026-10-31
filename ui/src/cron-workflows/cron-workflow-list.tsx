import {Page} from 'argo-ui/src/components/page/page';
import {SlidingPanel} from 'argo-ui/src/components/sliding-panel/sliding-panel';
import * as React from 'react';
import {useContext, useEffect, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router-dom';

import {uiUrl} from '../shared/base';
import {ErrorNotice} from '../shared/components/error-notice';
import {ExampleManifests} from '../shared/components/example-manifests';
import {InfoIcon} from '../shared/components/fa-icons';
import {Loading} from '../shared/components/loading';
import {TimestampSwitch} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {Context} from '../shared/context';
import {Footnote} from '../shared/footnote';
import {historyUrl} from '../shared/history';
import {CronWorkflow} from '../shared/models';
import {matchesLabelContains, matchesNameOrTitle} from '../shared/name-title-search';
import * as nsUtils from '../shared/namespaces';
import {services} from '../shared/services';
import {useCollectEvent} from '../shared/use-collect-event';
import {useQueryParams} from '../shared/use-query-params';
import useTimestamp, {TIMESTAMP_KEYS} from '../shared/use-timestamp';
import {CronWorkflowCreator} from './cron-workflow-creator';
import {CronWorkflowFilters} from './cron-workflow-filters';
import {CronWorkflowRow} from './cron-workflow-row';

import './cron-workflow-list.scss';

const learnMore = (
    <a href='https://argo-workflows.readthedocs.io/en/latest/cron-workflows/' target='_blank' rel='noreferrer'>
        Learn more
    </a>
);

export function filterSchedulesByState(workflows: CronWorkflow[], states: string[]) {
    return workflows.filter(item => states.includes(item.spec.suspend ? 'Suspended' : 'Running'));
}

export function CronWorkflowList({match, location, history}: RouteComponentProps<any>) {
    const queryParams = new URLSearchParams(location.search);
    const {navigation} = useContext(Context);

    // state for URL, query, and label parameters
    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState<string>(nsUtils.getNamespace(match.params.namespace) || '');
    const [sidePanel, setSidePanel] = useState(queryParams.get('sidePanel') === 'true');
    const [namePattern, setNamePattern] = useState(queryParams.get('name') || '');
    const [labelContains, setLabelContains] = useState(queryParams.get('labelContains') || '');
    const [labels, setLabels] = useState<string[]>([]);
    const [states, setStates] = useState(['Running', 'Suspended']); // check all by default

    const [storedDisplayISOFormatCreation, setStoredDisplayISOFormatCreation] = useTimestamp(TIMESTAMP_KEYS.CRON_WORKFLOW_LIST_CREATION);
    const [storedDisplayISOFormatNextScheduled, setStoredDisplayISOFormatNextScheduled] = useTimestamp(TIMESTAMP_KEYS.CRON_WORKFLOW_LIST_NEXT_SCHEDULED);

    useEffect(
        useQueryParams(history, p => {
            setSidePanel(p.get('sidePanel') === 'true');
            setNamePattern(p.get('name') || '');
            setLabelContains(p.get('labelContains') || '');
        }),
        [history]
    );

    // save history
    useEffect(() => {
        (isFirstRender.current ? history.replace : history.push)(
            historyUrl('cron-workflows' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {
                namespace,
                sidePanel,
                name: namePattern,
                labelContains
            })
        );
        isFirstRender.current = false;
    }, [namespace, sidePanel, namePattern, labelContains]);

    // internal state
    const [error, setError] = useState<Error>();
    const [cronWorkflows, setCronWorkflows] = useState<CronWorkflow[]>();

    useEffect(() => {
        (async () => {
            try {
                const list = await services.cronWorkflows.list(namespace, labels);
                setCronWorkflows(filterSchedulesByState(list, states));
                setError(null);
            } catch (newError) {
                setError(newError);
            }
        })();
    }, [namespace, labels.toString(), states.toString()]); // referential equality, so use values, not refs

    const visibleCronWorkflows = (cronWorkflows || []).filter(workflow => matchesNameOrTitle(workflow, namePattern) && matchesLabelContains(workflow, labelContains));

    useCollectEvent('openedCronWorkflowList');

    return (
        <Page
            title='Schedules'
            toolbar={{
                breadcrumbs: [
                    {title: 'Schedules', path: uiUrl('cron-workflows')},
                    {title: namespace, path: uiUrl('cron-workflows/' + namespace)}
                ],
                actionMenu: {
                    items: [
                        {
                            title: 'Create New Cron Workflow',
                            iconClassName: 'fa fa-plus',
                            action: () => setSidePanel(true)
                        }
                    ]
                }
            }}>
            <div>
                <CronWorkflowFilters
                    cronWorkflows={cronWorkflows || []}
                    namespace={namespace}
                    labels={labels}
                    states={states}
                    namePattern={namePattern}
                    onNamePatternChange={setNamePattern}
                    labelContains={labelContains}
                    onLabelContainsChange={setLabelContains}
                    onChange={(namespaceValue: string, labelsValue: string[], stateValue: string[]) => {
                        setNamespace(namespaceValue);
                        setLabels(labelsValue);
                        setStates(stateValue);
                    }}
                />
                <div className='filter-bar__results'>
                    <ErrorNotice error={error} />
                    {!cronWorkflows ? (
                        <Loading />
                    ) : visibleCronWorkflows.length === 0 ? (
                        <ZeroState title={namePattern || labelContains || labels.length || states.length !== 2 ? 'No matching schedules' : 'No schedules'}>
                            {namePattern || labelContains || labels.length || states.length !== 2 ? (
                                <p>Try changing or clearing your filters.</p>
                            ) : (
                                <p>You can create schedules here or using the CLI.</p>
                            )}
                            <p>
                                <ExampleManifests />. {learnMore}.
                            </p>
                        </ZeroState>
                    ) : (
                        <>
                            <div className='argo-table-list'>
                                <div className='row argo-table-list__head'>
                                    <div className='columns small-1' />
                                    <div className='columns small-2'>NAME</div>
                                    <div className='columns small-2'>NAMESPACE</div>
                                    <div className='columns small-1'>TimeZone</div>
                                    <div className='columns small-2'>SCHEDULES</div>
                                    <div className='columns small-2'>
                                        CREATED{' '}
                                        <TimestampSwitch storedDisplayISOFormat={storedDisplayISOFormatCreation} setStoredDisplayISOFormat={setStoredDisplayISOFormatCreation} />
                                    </div>
                                    <div className='columns small-2'>
                                        NEXT RUN{' '}
                                        <TimestampSwitch
                                            storedDisplayISOFormat={storedDisplayISOFormatNextScheduled}
                                            setStoredDisplayISOFormat={setStoredDisplayISOFormatNextScheduled}
                                        />
                                    </div>
                                </div>
                                {visibleCronWorkflows.map(w => {
                                    return (
                                        <CronWorkflowRow
                                            workflow={w}
                                            displayISOFormatCreation={storedDisplayISOFormatCreation}
                                            displayISOFormatNextScheduled={storedDisplayISOFormatNextScheduled}
                                            key={`${w.metadata.namespace}/${w.metadata.name}`}
                                        />
                                    );
                                })}
                            </div>
                            <Footnote>
                                <InfoIcon /> Schedules run workflows automatically. When no timezone is specified, the displayed next run is calculated in UTC. <ExampleManifests />
                                . {learnMore}.
                            </Footnote>
                        </>
                    )}
                </div>
            </div>
            <SlidingPanel isShown={sidePanel} onClose={() => setSidePanel(false)}>
                <CronWorkflowCreator namespace={namespace} onCreate={wf => navigation.goto(uiUrl(`cron-workflows/${wf.metadata.namespace}/${wf.metadata.name}`))} />
            </SlidingPanel>
        </Page>
    );
}
