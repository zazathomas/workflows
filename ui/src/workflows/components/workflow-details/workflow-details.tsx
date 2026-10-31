import {Page} from 'argo-ui/src/components/page/page';
import classNames from 'classnames';
import * as React from 'react';
import {useContext, useEffect, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router';

import {ANNOTATION_TITLE} from '../../../shared/annotations';
import {artifactRepoHasLocation, findArtifact} from '../../../shared/artifacts';
import {uiUrl} from '../../../shared/base';
import {AccessibleSlidingPanel} from '../../../shared/components/accessible-sliding-panel';
import {CostOptimisationNudge} from '../../../shared/components/cost-optimisation-nudge';
import {DropDown} from '../../../shared/components/dropdown/dropdown';
import {ErrorNotice} from '../../../shared/components/error-notice';
import {openLinkWithKey, processURL} from '../../../shared/components/links';
import {Loading} from '../../../shared/components/loading';
import {SecurityNudge} from '../../../shared/components/security-nudge';
import {hasArtifactGCError, hasWarningConditionBadge} from '../../../shared/conditions-panel';
import {Context} from '../../../shared/context';
import {historyUrl} from '../../../shared/history';
import {archivalStatus, ArtifactRepository, execSpec, isArchivedWorkflow, isWorkflowInCluster, Link, Parameter, Workflow} from '../../../shared/models';
import {getPodName} from '../../../shared/pod-name';
import {RetryWatch} from '../../../shared/retry-watch';
import {RunActionContext} from '../../../shared/run-action-context';
import {configFromAnnotations} from '../../../shared/run-actions';
import {services} from '../../../shared/services';
import {getMainContainerNames, getResolvedTemplates} from '../../../shared/template-resolution';
import {useCollectEvent} from '../../../shared/use-collect-event';
import {useQueryParams} from '../../../shared/use-query-params';
import {useResizableWidth} from '../../../shared/use-resizable-width';
import {useTransition} from '../../../shared/use-transition';
import * as Operations from '../../../shared/workflow-operations-map';
import {WorkflowOperations} from '../../../shared/workflow-operations-map';
import {WidgetGallery} from '../../../widgets/widget-gallery';
import {EventsPanel} from '../events-panel';
import {ResubmitWorkflowPanel} from '../resubmit-workflow-panel';
import {RetryWorkflowNode} from '../retry-workflow-node-panel';
import {RetryWorkflowPanel} from '../retry-workflow-panel';
import {WorkflowArtifacts} from '../workflow-artifacts';
import {WorkflowLogsViewer} from '../workflow-logs-viewer/workflow-logs-viewer';
import {WorkflowNodeInfo} from '../workflow-node-info/workflow-node-info';
import {WorkflowPanel} from '../workflow-panel/workflow-panel';
import {WorkflowSummaryPanel} from '../workflow-summary-panel';
import {WorkflowTimeline} from '../workflow-timeline/workflow-timeline';
import {WorkflowYamlViewer} from '../workflow-yaml-viewer/workflow-yaml-viewer';
import {ArtifactPanel} from './artifact-panel';
import {SuspendInputs} from './suspend-inputs';
import {WorkflowResourcePanel} from './workflow-resource-panel';

import './workflow-details.scss';

function parseSidePanelParam(param: string) {
    const [type, nodeId, container] = (param || '').split(':');
    return {type, nodeId, container};
}

const LEFT_NAV_WIDTH = 60;
const GRAPH_CONTAINER_MIN_WIDTH = 490;
const INITIAL_SIDE_PANEL_WIDTH = 570;
const ANIMATION_MS = 200;
const ANIMATION_BUFFER_MS = 20;

// This is used instead of React state since the state update is async and there's a delay for parent
// component to render with the updated state.
let globalDeleteArchived = false;

function DeleteCheck(props: {isWfInDB: boolean; isWfInCluster: boolean; workflowName: string}) {
    // The local states are created intentionally so that the checkbox works as expected
    const [da, sda] = useState(false);
    if (props.isWfInDB && props.isWfInCluster) {
        return (
            <>
                <p>Are you sure you want to delete the workflow &quot;{props.workflowName}&quot;?</p>
                <div className='workflows-list__status'>
                    <input
                        type='checkbox'
                        className='workflows-list__status--checkbox'
                        checked={da}
                        onClick={() => {
                            sda(!da);
                            globalDeleteArchived = !globalDeleteArchived;
                        }}
                        id='delete-check'
                    />
                    <label htmlFor='delete-check'>Delete in database</label>
                </div>
            </>
        );
    } else {
        return (
            <>
                <p>Are you sure you want to delete the workflow &quot;{props.workflowName}&quot;?</p>
            </>
        );
    }
}

export function WorkflowDetails({history, location, match}: RouteComponentProps<any>) {
    // boiler-plate
    const {navigation, popup} = useContext(Context);
    const runActions = useContext(RunActionContext);
    const queryParams = new URLSearchParams(location.search);
    const namespace = match.params.namespace;
    const name = match.params.name;

    const isFirstRender = useRef(true);
    const [tab, setTab] = useState(queryParams.get('tab') || 'summary');
    const [uid, setUid] = useState(queryParams.get('uid') || '');
    const [nodeId, setNodeId] = useState(queryParams.get('nodeId'));
    const [nodePanelView, setNodePanelView] = useState(queryParams.get('nodePanelView'));
    const [sidePanel, setSidePanel] = useState(queryParams.get('sidePanel'));
    const [showRetryNode, setShowRetryNode] = useState<boolean>();
    const [parameters, setParameters] = useState<Parameter[]>([]);
    const sidePanelRef = useRef<HTMLDivElement>(null);
    const [workflow, setWorkflow] = useState<Workflow>();
    const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>();
    const [isWatching, setIsWatching] = useState(false);
    const [links, setLinks] = useState<Link[]>();
    const [error, setError] = useState<Error>();
    const selectedNode = workflow?.status?.nodes?.[nodeId];
    const selectedArtifact = workflow?.status && findArtifact(workflow.status, nodeId);
    const [selectedTemplateArtifactRepo, setSelectedTemplateArtifactRepo] = useState<ArtifactRepository>();
    const isSidePanelExpanded = !!(selectedNode || selectedArtifact);
    const isSidePanelAnimating = useTransition(isSidePanelExpanded, ANIMATION_MS + ANIMATION_BUFFER_MS);
    const {width: sidePanelWidth, dragHandleProps: sidePanelDragHandleProps} = useResizableWidth({
        disabled: isSidePanelAnimating || !isSidePanelExpanded,
        initialWidth: INITIAL_SIDE_PANEL_WIDTH,
        maxWidth: globalThis.innerWidth - LEFT_NAV_WIDTH - GRAPH_CONTAINER_MIN_WIDTH,
        minWidth: INITIAL_SIDE_PANEL_WIDTH,
        resizedElementRef: sidePanelRef
    });

    useEffect(
        useQueryParams(history, p => {
            setUid(p.get('uid'));
            setTab(p.get('tab') || 'summary');
            setNodeId(p.get('nodeId'));
            setNodePanelView(p.get('nodePanelView'));
            setSidePanel(p.get('sidePanel'));
        }),
        [history]
    );

    function getInputParametersForNode(selectedWorkflowNodeId: string): Parameter[] {
        const selectedWorkflowNode = workflow && workflow.status && workflow.status.nodes && workflow.status.nodes[selectedWorkflowNodeId];
        return (
            selectedWorkflowNode?.inputs?.parameters?.map(param => {
                const paramClone = {...param};
                if (paramClone.enum && !paramClone.value) {
                    paramClone.value = paramClone.default;
                }
                return paramClone;
            }) || []
        );
    }

    useEffect(() => {
        // update the default Artifact Repository for the Template that corresponds to the selectedArtifact
        // if there's an ArtifactLocation configured for the Template we use that
        // otherwise we use the central one for the Workflow configured in workflow.status.artifactRepositoryRef.artifactRepository
        // (Note that individual Artifacts may also override whatever this gets set to)
        if (workflow?.status?.nodes && selectedArtifact) {
            const template = getResolvedTemplates(workflow, workflow.status.nodes[selectedArtifact.nodeId]);
            const artifactRepo = template?.archiveLocation;
            if (artifactRepo && artifactRepoHasLocation(artifactRepo)) {
                setSelectedTemplateArtifactRepo(artifactRepo);
            } else {
                setSelectedTemplateArtifactRepo(workflow.status.artifactRepositoryRef.artifactRepository);
            }
        }
    }, [workflow, selectedArtifact]);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        history.push(historyUrl('workflows/{namespace}/{name}', {namespace, name, tab, nodeId, nodePanelView, sidePanel, uid}));
    }, [namespace, name, tab, nodeId, nodePanelView, sidePanel, uid]);

    useEffect(() => {
        (async () => {
            try {
                const info = await services.info.getInfo();
                setLinks(info.links);
            } catch (err) {
                setError(err);
            }
        })();
    }, []);

    useCollectEvent('openedWorkflowDetails');

    // Restore monitoring when a Run is opened directly, including after a reload.
    useEffect(() => {
        if (
            workflow?.metadata.uid &&
            configFromAnnotations(workflow.metadata.annotations) &&
            !workflow.status?.finishedAt &&
            !['Succeeded', 'Failed', 'Error'].includes(workflow.status?.phase)
        ) {
            runActions?.track(workflow);
        }
    }, [runActions, workflow?.metadata.uid]);

    useEffect(() => {
        setParameters(getInputParametersForNode(nodeId));
    }, [nodeId, workflow]);

    const parsedSidePanel = parseSidePanelParam(sidePanel);

    function getItems() {
        const workflowOperationsMap: WorkflowOperations = Operations.WorkflowOperationsMap;
        const items = Object.keys(workflowOperationsMap)
            .filter(actionName => !workflowOperationsMap[actionName].disabled(workflow))
            .map(actionName => {
                const workflowOperation = workflowOperationsMap[actionName];
                const operationTitle = workflowOperation.title.toLowerCase();
                return {
                    title: operationTitle.charAt(0).toUpperCase() + operationTitle.slice(1),
                    iconClassName: workflowOperation.iconClassName,
                    action: () => {
                        if (workflowOperation.title === 'DELETE') {
                            popup
                                .confirm('Confirm workflow deletion', () => (
                                    <DeleteCheck isWfInDB={isArchivedWorkflow(workflow)} isWfInCluster={isWorkflowInCluster(workflow)} workflowName={workflow.metadata.name} />
                                ))
                                .then(async yes => {
                                    if (!yes) return;

                                    const allPromises = [];
                                    if (isWorkflowInCluster(workflow)) {
                                        allPromises.push(services.workflows.delete(workflow.metadata.name, workflow.metadata.namespace).catch(setError));
                                    }
                                    if (isArchivedWorkflow(workflow) && (globalDeleteArchived || !isWorkflowInCluster(workflow))) {
                                        allPromises.push(services.workflows.deleteArchived(workflow.metadata.uid, workflow.metadata.namespace).catch(setError));
                                    }
                                    await Promise.all(allPromises);
                                    if (error !== null) {
                                        return;
                                    }

                                    navigation.goto(uiUrl(`workflows/${workflow.metadata.namespace}`));
                                });
                        } else if (workflowOperation.title === 'RESUBMIT') {
                            setSidePanel('resubmit');
                        } else if (workflowOperation.title === 'RETRY') {
                            setSidePanel('retry');
                        } else {
                            popup
                                .confirm(
                                    `Confirm ${workflowOperation.title.toLowerCase()}`,
                                    `Are you sure you want to ${workflowOperation.title.toLowerCase()} the workflow "${workflow.metadata.name}"?`
                                )
                                .then(yes => {
                                    if (!yes) return;

                                    workflowOperation.action(workflow).catch(setError);
                                });
                        }
                    }
                };
            });

        items.push({
            action: () => setSidePanel('logs'),
            iconClassName: 'fa fa-bars',
            title: 'Logs'
        });

        items.push({
            action: () => setSidePanel('share'),
            iconClassName: 'fa fa-share-alt',
            title: 'Share'
        });

        if (links) {
            links
                .filter(link => link.scope === 'workflow')
                .forEach(link => {
                    items.push({
                        title: link.name,
                        iconClassName: 'fa fa-external-link-alt',
                        action: () => openLink(link)
                    });
                });
        }

        // we only want one link, and we have a preference
        for (const k of [
            'workflows.argoproj.io/workflow-template',
            'workflows.argoproj.io/cluster-workflow-template',
            'workflows.argoproj.io/cron-workflow',
            'workflows.argoproj.io/workflow-event-binding',
            'workflows.argoproj.io/resubmitted-from-workflow'
        ]) {
            const labels = workflow?.metadata?.labels || {};
            const v = labels[k];
            if (v) {
                items.push({
                    title: 'Previous Runs',
                    iconClassName: 'fa fa-search',
                    action: () => navigation.goto(uiUrl(`workflows/${workflow.metadata.namespace}?label=${k}=${v}`))
                });
                break; // only add one item
            }
        }

        if (workflow?.spec?.workflowTemplateRef) {
            const templateName: string = workflow.spec.workflowTemplateRef.name;
            const clusterScope: boolean = workflow.spec.workflowTemplateRef.clusterScope;
            const url: string = clusterScope ? uiUrl(`cluster-workflow-templates/${templateName}`) : uiUrl(`workflow-templates/${workflow.metadata.namespace}/${templateName}`);
            const icon: string = clusterScope ? 'fa fa-window-restore' : 'fa fa-window-maximize';

            const templateLink: Link = {
                name: 'Open Workflow Template',
                scope: 'workflow',
                url
            };

            items.push({
                title: templateLink.name,
                iconClassName: icon,
                action: () => openLink(templateLink)
            });
        }

        return items;
    }

    function renderSecurityNudge() {
        if (!execSpec(workflow).securityContext) {
            return <SecurityNudge>This workflow does not have security context set. It maybe possible to set this to run it more securely.</SecurityNudge>;
        }
    }

    function renderCostOptimisations() {
        const recommendations: string[] = [];
        if (!execSpec(workflow).activeDeadlineSeconds) {
            recommendations.push('activeDeadlineSeconds');
        }
        if (!execSpec(workflow).ttlStrategy) {
            recommendations.push('ttlStrategy');
        }
        if (!execSpec(workflow).podGC) {
            recommendations.push('podGC');
        }
        if (recommendations.length === 0) {
            return;
        }
        return (
            <CostOptimisationNudge name='workflow'>
                You do not have {recommendations.join('/')} enabled for this workflow. Enabling these will reduce your costs.
            </CostOptimisationNudge>
        );
    }

    function renderSummaryTab() {
        return (
            <>
                {!workflow ? (
                    !error && <Loading />
                ) : (
                    <div className='workflow-details__container'>
                        <div className='argo-container'>
                            <div className='workflow-details__content'>
                                <WorkflowSummaryPanel workflow={workflow} />
                                {(workflow.status.phase === 'Failed' || workflow.status.phase === 'Error') && (
                                    <section className='white-box' aria-label='Run failure'>
                                        <h5>Run failed</h5>
                                        <p>{workflow.status.message || 'Check the steps and logs for more information.'}</p>
                                        <button type='button' className='argo-button argo-button--base-o' onClick={() => setTab('workflow')}>
                                            View steps
                                        </button>
                                        <button type='button' className='argo-button argo-button--base-o' onClick={() => setSidePanel('logs')}>
                                            View logs
                                        </button>
                                    </section>
                                )}
                                <section className='workflow-details__section' aria-labelledby='workflow-outputs-heading'>
                                    <h5 id='workflow-outputs-heading'>Outputs and artifacts{artifactCount ? ` (${artifactCount})` : ''}</h5>
                                    <WorkflowArtifacts workflow={workflow} archived={isArchivedWorkflow(workflow)} />
                                </section>
                                <details className='workflow-details__section'>
                                    <summary>Advanced workflow information</summary>
                                    {renderSecurityNudge()}
                                    {renderCostOptimisations()}
                                    <WorkflowResourcePanel workflow={workflow} />
                                </details>
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    }

    useEffect(() => {
        if (!isWorkflowInCluster(workflow)) {
            return;
        }
        let disposed = false;
        const retryWatch = new RetryWatch<Workflow>(
            () => services.workflows.watch({name, namespace}),
            () => {
                setError(null);
                setIsWatching(true);
            },
            e => {
                setLastUpdatedAt(new Date());
                setIsWatching(true);
                if (e.type === 'DELETED') {
                    setUid(e.object.metadata.uid);
                    if (e.object.metadata.labels?.[archivalStatus]) {
                        e.object.metadata.labels[archivalStatus] = 'Persisted';
                    } else {
                        setError(new Error('Workflow gone'));
                    }
                    setWorkflow(e.object);
                } else {
                    if (hasArtifactGCError(e.object.status.conditions)) {
                        setError(new Error('Artifact garbage collection failed'));
                    }
                    setWorkflow(e.object);
                }
            },
            err => {
                if (disposed) {
                    return;
                }
                setIsWatching(false);
                setError(err);
                services.workflows
                    .get(namespace, name)
                    .then(updatedWorkflow => {
                        if (disposed) {
                            return;
                        }
                        setWorkflow(updatedWorkflow);
                        setLastUpdatedAt(new Date());
                        setError(null);
                    })
                    .catch(() => undefined);
            }
        );
        retryWatch.start();
        return () => {
            disposed = true;
            retryWatch.stop();
        };
    }, [namespace, name, isWorkflowInCluster(workflow)]);

    // Get workflow
    useEffect(() => {
        (async () => {
            try {
                // Pass uid if available from URL query params
                const wf = await services.workflows.get(namespace, name, uid || undefined);
                setUid(wf.metadata.uid);
                setWorkflow(wf);
                setLastUpdatedAt(new Date());
                setIsWatching(false);
                setError(null);
                return;
            } catch (err) {
                if (err.status !== 404 && uid === '') {
                    setError(err);
                    return;
                }

                try {
                    const archivedWf = await services.workflows.getArchived(namespace, uid);
                    setWorkflow(archivedWf);
                    setIsWatching(false);
                    setLastUpdatedAt(new Date());
                    setError(null);
                    return;
                } catch (archiveErr) {
                    if (archiveErr.status === 500 && archiveErr.response.body.message === 'getting archived workflows not supported') {
                        setError(err);
                        return;
                    }

                    setError(archiveErr);
                }
            }
        })();
    }, [namespace, name, uid]);

    function openLink(link: Link) {
        const object = {
            metadata: {
                namespace: workflow.metadata.namespace,
                name: workflow.metadata.name
            },
            workflow,
            status: {
                startedAt: workflow.status.startedAt,
                finishedAt: workflow.status.finishedAt
            }
        };
        openLinkWithKey(processURL(link.url, object), link.target);
    }

    function setParameter(key: string, value: string) {
        setParameters(previous => {
            return previous?.map(parameter => {
                if (parameter.name === key) {
                    parameter.value = value;
                }
                return parameter;
            });
        });
    }

    function renderSuspendNodeOptions() {
        return <SuspendInputs parameters={parameters} nodeId={nodeId} setParameter={setParameter} />;
    }

    function getParametersAsJsonString() {
        const outputVariables: {[x: string]: string} = {};
        parameters.forEach(param => {
            outputVariables[param.name] = param.value;
        });
        return JSON.stringify(outputVariables);
    }

    function updateOutputParametersForNodeIfRequired() {
        // No need to set outputs on node if there are no parameters
        if (parameters.length > 0) {
            return services.workflows.set(workflow.metadata.name, workflow.metadata.namespace, 'id=' + nodeId, getParametersAsJsonString());
        }
        return Promise.resolve(null);
    }

    function resumeNode() {
        return services.workflows.resume(workflow.metadata.name, workflow.metadata.namespace, 'id=' + nodeId);
    }

    function renderResumePopup() {
        return popup.confirm('Confirm', renderSuspendNodeOptions).then(yes => {
            if (!yes) return;

            updateOutputParametersForNodeIfRequired().then(resumeNode).catch(setError);
        });
    }

    const podName = workflow && selectedNode ? getPodName(workflow, selectedNode) : nodeId;

    const archived = isArchivedWorkflow(workflow);
    const workflowTitle = workflow?.metadata.annotations?.[ANNOTATION_TITLE] || name;
    const artifactCount = Object.values(workflow?.status?.nodes || {}).reduce((count, node) => count + (node.outputs?.artifacts?.length || 0), 0);
    const toolbarItems = getItems();
    const primaryToolbarItems = toolbarItems.filter(item => ['Retry', 'Resubmit', 'Resume'].includes(item.title as string));
    const logsToolbarItem = toolbarItems.find(item => item.title === 'Logs');
    const secondaryToolbarItems = toolbarItems.filter(item => !primaryToolbarItems.includes(item) && item !== logsToolbarItem);

    return (
        <div className='workflow-details-page'>
            <Page
                title={'Workflow Details'}
                toolbar={{
                    breadcrumbs: [
                        {title: 'Workflows', path: uiUrl('workflows')},
                        {title: namespace, path: uiUrl('workflows/' + namespace)},
                        {title: workflowTitle, path: uiUrl('workflows/' + namespace + '/' + name)}
                    ]
                }}>
                <h1 className='modern-visually-hidden'>{workflowTitle} workflow details</h1>
                <div className='workflow-details__command-bar' aria-label='Workflow controls'>
                    <div className='workflow-details__actions'>
                        {primaryToolbarItems.map(item => (
                            <button type='button' className='argo-button argo-button--base workflow-details__primary-action' onClick={item.action} key={item.title as string}>
                                {item.iconClassName && <i className={item.iconClassName} aria-hidden='true' />} {item.title}
                            </button>
                        ))}
                        {logsToolbarItem && (
                            <button type='button' className='argo-button argo-button--base-o' onClick={logsToolbarItem.action}>
                                <i className={logsToolbarItem.iconClassName} aria-hidden='true' /> Logs
                            </button>
                        )}
                        {secondaryToolbarItems.length > 0 && (
                            <DropDown
                                isMenu
                                closeOnInsideClick
                                contentClassName='workflow-details__actions-menu'
                                anchor={(opened: boolean) => (
                                    <button type='button' className='argo-button argo-button--base-o' aria-expanded={opened} aria-haspopup='menu'>
                                        More actions <i className='fa fa-caret-down' aria-hidden='true' />
                                    </button>
                                )}>
                                <ul className='workflow-details__more-menu' role='menu'>
                                    {secondaryToolbarItems.map(item => {
                                        const destructive = ['Stop', 'Terminate', 'Delete'].includes(item.title as string);
                                        return (
                                            <li key={item.title as string} role='none'>
                                                <button
                                                    type='button'
                                                    role='menuitem'
                                                    className={classNames({'workflow-details__danger-action': destructive})}
                                                    onClick={item.action}>
                                                    {item.iconClassName && <i className={item.iconClassName} aria-hidden='true' />} {item.title}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </DropDown>
                        )}
                    </div>
                    <div
                        className='workflow-details__topbar-buttons'
                        role='tablist'
                        aria-label='Workflow views'
                        onKeyDown={event => {
                            const tabKeys = ['summary', 'workflow', 'events', 'timeline'];
                            const currentIndex = tabKeys.indexOf(tab);
                            let nextIndex: number | undefined;
                            if (event.key === 'ArrowRight') {
                                nextIndex = (currentIndex + 1) % tabKeys.length;
                            } else if (event.key === 'ArrowLeft') {
                                nextIndex = (currentIndex - 1 + tabKeys.length) % tabKeys.length;
                            } else if (event.key === 'Home') {
                                nextIndex = 0;
                            } else if (event.key === 'End') {
                                nextIndex = tabKeys.length - 1;
                            }
                            if (nextIndex !== undefined) {
                                event.preventDefault();
                                setTab(tabKeys[nextIndex]);
                                const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role=tab]');
                                tabs[nextIndex]?.focus();
                            }
                        }}>
                        <button
                            type='button'
                            role='tab'
                            id='workflow-tab-summary'
                            aria-controls='workflow-view-panel'
                            aria-selected={tab === 'summary'}
                            className={classNames({active: tab === 'summary'})}
                            onClick={() => setTab('summary')}
                            tabIndex={tab === 'summary' ? 0 : -1}
                            title='Summary'>
                            <i className='fa fa-columns' aria-hidden='true' />
                            <span>Overview</span>
                            {workflow && workflow.status.conditions && hasWarningConditionBadge(workflow.status.conditions) && <span className='badge' />}
                        </button>
                        <button
                            type='button'
                            role='tab'
                            id='workflow-tab-workflow'
                            aria-controls='workflow-view-panel'
                            aria-selected={tab === 'workflow'}
                            className={classNames({active: tab === 'workflow'})}
                            onClick={() => setTab('workflow')}
                            tabIndex={tab === 'workflow' ? 0 : -1}
                            title='Workflow graph'>
                            <i className='argo-icon-workflow' aria-hidden='true' />
                            <span>Graph</span>
                        </button>
                        <button
                            type='button'
                            role='tab'
                            id='workflow-tab-events'
                            aria-controls='workflow-view-panel'
                            aria-selected={tab === 'events'}
                            className={classNames({active: tab === 'events'})}
                            onClick={() => setTab('events')}
                            tabIndex={tab === 'events' ? 0 : -1}
                            title='Events'>
                            <i className='argo-icon-notification' aria-hidden='true' />
                            <span>Events</span>
                        </button>
                        <button
                            type='button'
                            role='tab'
                            id='workflow-tab-timeline'
                            aria-controls='workflow-view-panel'
                            aria-selected={tab === 'timeline'}
                            className={classNames({active: tab === 'timeline'})}
                            onClick={() => setTab('timeline')}
                            tabIndex={tab === 'timeline' ? 0 : -1}
                            title='Timeline'>
                            <i className='argo-icon-timeline' aria-hidden='true' />
                            <span>Timeline</span>
                        </button>
                        {workflow && !archived && (
                            <span
                                className={classNames('workflow-details__live-indicator', {'workflow-details__live-indicator--offline': !isWatching})}
                                role='status'
                                aria-live='polite'
                                aria-label={isWatching ? 'Live workflow updates connected' : 'Live workflow updates paused'}>
                                <i className={`fa ${isWatching ? 'fa-circle' : 'fa-pause-circle'}`} aria-hidden='true' />
                                <span>{isWatching ? 'Live' : 'Live updates paused'}</span>
                                {lastUpdatedAt && <span className='workflow-details__live-updated'>Updated {lastUpdatedAt.toLocaleTimeString()}</span>}
                            </span>
                        )}
                    </div>
                </div>
                <div className={classNames('workflow-details', {'workflow-details--step-node-expanded': isSidePanelExpanded})}>
                    <ErrorNotice error={error} />
                    <div role='tabpanel' id='workflow-view-panel' aria-labelledby={`workflow-tab-${tab}`} tabIndex={0}>
                        {(tab === 'summary' && renderSummaryTab()) ||
                            (workflow && (
                                <div className='workflow-details__graph-container-wrapper'>
                                    <div className='workflow-details__graph-container'>
                                        {(tab === 'workflow' && (
                                            <WorkflowPanel workflowMetadata={workflow.metadata} workflowStatus={workflow.status} selectedNodeId={nodeId} nodeClicked={setNodeId} />
                                        )) ||
                                            (tab === 'events' && <EventsPanel namespace={workflow.metadata.namespace} kind='Workflow' name={workflow.metadata.name} />) || (
                                                <WorkflowTimeline workflow={workflow} selectedNodeId={nodeId} nodeClicked={node => setNodeId(node.id)} />
                                            )}
                                    </div>
                                    <div
                                        className='workflow-details__step-info'
                                        ref={sidePanelRef}
                                        style={{
                                            minWidth: !isSidePanelExpanded || isSidePanelAnimating ? 0 : `${INITIAL_SIDE_PANEL_WIDTH}px`,
                                            transition: isSidePanelAnimating ? `width ${ANIMATION_MS}ms` : 'unset',
                                            width: isSidePanelExpanded ? `${sidePanelWidth}px` : 0
                                        }}>
                                        <button
                                            className='workflow-details__step-info-close'
                                            aria-label='Close step details'
                                            onClick={() => {
                                                if (showRetryNode) {
                                                    setShowRetryNode(false);
                                                } else {
                                                    setNodeId(null);
                                                }
                                            }}>
                                            <i className='argo-icon-close' />
                                        </button>

                                        <div className='workflow-details__step-info-drag-handle' {...sidePanelDragHandleProps} />
                                        {selectedNode && showRetryNode && (
                                            <RetryWorkflowNode
                                                nodeId={selectedNode.id}
                                                workflow={workflow}
                                                isArchived={isArchivedWorkflow(workflow)}
                                                isWorkflowInCluster={isWorkflowInCluster(workflow)}
                                                onRetrySuccess={() => setShowRetryNode(false)}
                                            />
                                        )}
                                        {selectedNode && !showRetryNode && (
                                            <WorkflowNodeInfo
                                                node={selectedNode}
                                                onTabSelected={setNodePanelView}
                                                selectedTabKey={nodePanelView}
                                                workflow={workflow}
                                                links={links}
                                                onShowContainerLogs={(x, container) => setSidePanel(`logs:${x}:${container}`)}
                                                onShowEvents={() => setSidePanel(`events:${nodeId}`)}
                                                onShowYaml={() => setSidePanel(`yaml:${nodeId}`)}
                                                onRetryNode={() => setShowRetryNode(true)}
                                                archived={archived}
                                                onResume={() => renderResumePopup()}
                                            />
                                        )}
                                        {selectedArtifact && (
                                            <ArtifactPanel workflow={workflow} artifact={selectedArtifact} archived={archived} artifactRepository={selectedTemplateArtifactRepo} />
                                        )}
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>
                {workflow && (
                    <AccessibleSlidingPanel
                        isShown={!!sidePanel}
                        closeLabel='Close workflow panel'
                        onClose={() => setSidePanel(null)}
                        isMiddle={['resubmit', 'retry'].includes(parsedSidePanel.type)}>
                        {parsedSidePanel.type === 'logs' && (
                            <WorkflowLogsViewer
                                workflow={workflow}
                                initialPodName={podName}
                                initialNodeId={parsedSidePanel.nodeId}
                                container={parsedSidePanel.container || getMainContainerNames(workflow, workflow.status.nodes[parsedSidePanel.nodeId])[0]}
                                archived={isArchivedWorkflow(workflow)}
                            />
                        )}
                        {parsedSidePanel.type === 'events' && <EventsPanel namespace={namespace} kind='Pod' name={podName} />}
                        {parsedSidePanel.type === 'share' && <WidgetGallery namespace={namespace} name={name} />}
                        {parsedSidePanel.type === 'yaml' && <WorkflowYamlViewer workflow={workflow} selectedNode={selectedNode} />}
                        {parsedSidePanel.type === 'resubmit' && <ResubmitWorkflowPanel workflow={workflow} isArchived={isArchivedWorkflow(workflow)} />}
                        {parsedSidePanel.type === 'retry' && (
                            <RetryWorkflowPanel workflow={workflow} isArchived={isArchivedWorkflow(workflow)} isWorkflowInCluster={isWorkflowInCluster(workflow)} />
                        )}
                        {!parsedSidePanel}
                    </AccessibleSlidingPanel>
                )}
            </Page>
        </div>
    );
}
