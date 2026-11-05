import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useContext, useEffect, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router-dom';

import {ClusterWorkflowTemplateCreator} from '../cluster-workflow-templates/cluster-workflow-template-creator';
import {uiUrl} from '../shared/base';
import {AccessibleSlidingPanel} from '../shared/components/accessible-sliding-panel';
import {ErrorNotice} from '../shared/components/error-notice';
import {ExampleManifests} from '../shared/components/example-manifests';
import {InfoIcon} from '../shared/components/fa-icons';
import {Loading} from '../shared/components/loading';
import {PaginationPanel} from '../shared/components/pagination-panel';
import {TimestampSwitch} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {Context} from '../shared/context';
import {Footnote} from '../shared/footnote';
import {historyUrl} from '../shared/history';
import {WorkflowTemplate} from '../shared/models';
import {fetchAllPages, matchesLabelContains, matchesNameOrTitle, searchPageOffset} from '../shared/name-title-search';
import * as nsUtils from '../shared/namespaces';
import {Pagination, parseLimit} from '../shared/pagination';
import {ScopedLocalStorage} from '../shared/scoped-local-storage';
import {services} from '../shared/services';
import {useCollectEvent} from '../shared/use-collect-event';
import {useQueryParams} from '../shared/use-query-params';
import useTimestamp, {TIMESTAMP_KEYS} from '../shared/use-timestamp';
import {WorkflowTemplateCreator} from './workflow-template-creator';
import {JobTypeFilter, WorkflowTemplateFilters} from './workflow-template-filters';
import {WorkflowTemplateRow} from './workflow-template-row';

import './workflow-template-list.scss';

const learnMore = (
    <a href='https://argo-workflows.readthedocs.io/en/latest/workflow-templates/' target='_blank' rel='noreferrer'>
        Learn more
    </a>
);

function parseJobType(value: string): JobTypeFilter {
    return value === 'workflow' || value === 'cluster' ? value : 'both';
}

export function WorkflowTemplateList({match, location, history}: RouteComponentProps<any>) {
    // boiler-plate
    const isFirstRender = useRef(true);
    const queryParams = new URLSearchParams(location.search);
    const {navigation} = useContext(Context);

    const storage = new ScopedLocalStorage('WorkflowTemplateListOptions');
    const savedPaginationLimit = storage.getItem('paginationLimit', 500);

    // state for URL and query parameters
    const [namespace, setNamespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [sidePanel, setSidePanel] = useState(queryParams.get('sidePanel') === 'true');
    const [selectedCreateType, setSelectedCreateType] = useState<'workflow' | 'cluster'>();
    const [editorType, setEditorType] = useState<'workflow' | 'cluster'>();
    const editorHeadingRef = useRef<HTMLHeadingElement>(null);
    const [namePattern, setNamePattern] = useState(queryParams.get('name') || '');
    const [labelContains, setLabelContains] = useState(queryParams.get('labelContains') || '');
    const [jobType, setJobType] = useState<JobTypeFilter>(parseJobType(queryParams.get('type')));
    const [labels, setLabels] = useState<string[]>(() => {
        const savedOptions = storage.getItem('options', {});
        const savedLabels = savedOptions.labels || [];
        const labelQueryParam = queryParams.getAll('label');
        return labelQueryParam.length > 0 ? labelQueryParam : savedLabels;
    });

    const [pagination, setPagination] = useState<Pagination>({
        offset: queryParams.get('offset'),
        limit: parseLimit(queryParams.get('limit')) ?? savedPaginationLimit
    });

    useEffect(
        useQueryParams(history, p => {
            setSidePanel(p.get('sidePanel') === 'true');
            setNamePattern(p.get('name') || '');
            setLabelContains(p.get('labelContains') || '');
            setJobType(parseJobType(p.get('type')));
            setLabels(p.getAll('label'));
            setPagination(current => {
                const offset = p.get('offset') || undefined;
                const limit = parseLimit(p.get('limit')) ?? savedPaginationLimit;
                return offset === (current.offset || undefined) && limit === current.limit ? current : {offset, limit};
            });
        }),
        [history]
    );

    useEffect(() => {
        if (!sidePanel) {
            setSelectedCreateType(undefined);
            setEditorType(undefined);
        }
    }, [sidePanel]);

    useEffect(() => {
        if (sidePanel && editorType) editorHeadingRef.current?.focus();
    }, [sidePanel, editorType]);

    useEffect(() => {
        storage.setItem('options', {labels}, {});
        const params = new URLSearchParams();
        labels?.forEach(label => params.append('label', label));
        if (namePattern) {
            params.set('name', namePattern);
        }
        if (labelContains) params.set('labelContains', labelContains);
        if (jobType !== 'both') params.set('type', jobType);
        if (sidePanel) {
            params.append('sidePanel', 'true');
        }
        if (pagination.offset) params.set('offset', pagination.offset);
        if (pagination.limit !== undefined) params.set('limit', String(pagination.limit));
        (isFirstRender.current ? history.replace : history.push)(
            historyUrl('workflow-templates' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {
                namespace,
                extraSearchParams: params
            })
        );
        isFirstRender.current = false;
    }, [namespace, sidePanel, namePattern, labelContains, jobType, labels.toString(), pagination.offset, pagination.limit]);
    // internal state
    const [error, setError] = useState<Error>();
    const [templates, setTemplates] = useState<WorkflowTemplate[]>();
    const [clusterTemplates, setClusterTemplates] = useState<WorkflowTemplate[]>();
    const [clusterError, setClusterError] = useState<Error>();
    const [searchTruncated, setSearchTruncated] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setTemplates(undefined);
        setError(undefined);
        setSearchTruncated(false);
        if (jobType === 'cluster') {
            setTemplates([]);
            return () => {
                cancelled = true;
            };
        }
        const searchAll = !!(namePattern.trim() || labelContains.trim());
        const request = searchAll
            ? fetchAllPages(page => {
                  if (cancelled) return Promise.reject(new Error('Search cancelled'));
                  return services.workflowTemplate.list(namespace, labels, '', page);
              })
            : services.workflowTemplate.list(namespace, labels, '', pagination);
        request
            .then(list => {
                if (cancelled) return;
                if (!searchAll) {
                    setPagination(current => ({...current, nextOffset: list.metadata?.continue}));
                    setTemplates(list.items || []);
                    return;
                }
                setSearchTruncated(!!('truncated' in list && list.truncated));
                const matching = (list.items || []).filter(template => matchesNameOrTitle(template, namePattern) && matchesLabelContains(template, labelContains));
                const offset = searchPageOffset(pagination.offset);
                if (offset > 0 && offset >= matching.length) {
                    setPagination(current => ({...current, offset: undefined, nextOffset: undefined}));
                    return;
                }
                const end = pagination.limit > 0 ? offset + pagination.limit : matching.length;
                setPagination(current => ({...current, nextOffset: end < matching.length ? `search:${end}` : undefined}));
                setTemplates(matching.slice(offset, end));
            })
            .catch(err => {
                if (!cancelled) setError(err);
            });
        return () => {
            cancelled = true;
        };
    }, [namespace, namePattern, labelContains, labels.toString(), pagination.offset, pagination.limit, jobType]); // referential equality, so use values, not refs
    useEffect(() => {
        let cancelled = false;
        setClusterTemplates(undefined);
        setClusterError(undefined);
        if (jobType === 'workflow') {
            setClusterTemplates([]);
        } else {
            services.clusterWorkflowTemplate
                .list(labels)
                .then(items => {
                    if (!cancelled) setClusterTemplates(items);
                })
                .catch(err => {
                    if (!cancelled) setClusterError(err);
                });
        }
        return () => {
            cancelled = true;
        };
    }, [jobType, labels.toString()]);
    useEffect(() => {
        storage.setItem('paginationLimit', pagination.limit, 500);
    }, [pagination.limit]);

    useCollectEvent('openedWorkflowTemplateList');

    const [storedDisplayISOFormat, setStoredDisplayISOFormat] = useTimestamp(TIMESTAMP_KEYS.WORKFLOW_TEMPLATE_LIST_CREATION);
    const visibleTemplates = templates || [];
    const visibleClusterTemplates = (clusterTemplates || []).filter(template => matchesNameOrTitle(template, namePattern) && matchesLabelContains(template, labelContains));
    const loading = (!templates && !error) || (!clusterTemplates && !clusterError);
    const totalShown = visibleTemplates.length + visibleClusterTemplates.length;

    return (
        <Page
            title='Jobs'
            toolbar={{
                breadcrumbs: [
                    {title: 'Jobs', path: uiUrl('workflow-templates')},
                    {title: namespace, path: uiUrl('workflow-templates/' + namespace)}
                ],
                actionMenu: {
                    items: [
                        {
                            title: 'Create job template',
                            iconClassName: 'fa fa-plus',
                            action: () => setSidePanel(true)
                        }
                    ]
                }
            }}>
            <div>
                <WorkflowTemplateFilters
                    templates={[...(templates || []), ...(clusterTemplates || [])]}
                    namespace={namespace}
                    namePattern={namePattern}
                    labelContains={labelContains}
                    onLabelContainsChange={value => {
                        setLabelContains(value);
                        setPagination(current => ({...current, offset: undefined}));
                    }}
                    labels={labels}
                    jobType={jobType}
                    onJobTypeChange={value => {
                        setJobType(value);
                        setPagination(current => ({...current, offset: undefined}));
                    }}
                    onChange={(namespaceValue: string, namePatternValue: string, labelsValue: string[]) => {
                        setNamespace(namespaceValue);
                        setNamePattern(namePatternValue);
                        setLabels(labelsValue);
                        setPagination({...pagination, offset: ''});
                    }}
                />
                <div className='filter-bar__results'>
                    {searchTruncated && <p role='status'>Search scanned the first 2,000 namespace jobs only. Refine your search to find other matches.</p>}
                    {jobType === 'both' && pagination.limit !== 0 && <p>Namespace templates are paginated; cluster templates appear on every namespace page.</p>}
                    {error && (
                        <>
                            <p>Could not load namespace templates.</p>
                            <ErrorNotice error={error} />
                        </>
                    )}
                    {clusterError && (
                        <>
                            <p>Could not load cluster templates. You may not have permission to list them.</p>
                            <ErrorNotice error={clusterError} />
                        </>
                    )}
                    {loading ? (
                        <>
                            {(namePattern.trim() || labelContains.trim()) && <p role='status'>Searching the first 2,000 namespace jobs...</p>}
                            <Loading />
                        </>
                    ) : totalShown === 0 ? (
                        !error &&
                        !clusterError && (
                            <ZeroState title={namePattern || labelContains || labels.length ? 'No matching jobs' : 'No jobs'}>
                                {namePattern || labelContains || labels.length ? (
                                    <p>Try changing or clearing your filters.</p>
                                ) : (
                                    <p>You can create a job template here or using the CLI.</p>
                                )}
                                <p>
                                    <ExampleManifests />. {learnMore}.
                                </p>
                            </ZeroState>
                        )
                    ) : (
                        <>
                            <p role='status'>
                                {totalShown} {totalShown === 1 ? 'job' : 'jobs'} shown from loaded results
                            </p>
                            <div className='argo-table-list' role='table' aria-label='Jobs'>
                                <div className='row argo-table-list__head' role='row'>
                                    <div className='columns small-6' role='columnheader'>
                                        NAME AND TYPE
                                    </div>
                                    <div className='columns small-2' role='columnheader'>
                                        NAMESPACE AND TEAM
                                    </div>
                                    <div className='columns small-2' role='columnheader'>
                                        CREATED <TimestampSwitch storedDisplayISOFormat={storedDisplayISOFormat} setStoredDisplayISOFormat={setStoredDisplayISOFormat} />
                                    </div>
                                    <div className='columns small-2' role='columnheader'>
                                        ACTION
                                    </div>
                                </div>
                                {visibleTemplates.map(t => (
                                    <WorkflowTemplateRow workflow={t} displayISOFormat={storedDisplayISOFormat} key={`namespace/${t.metadata.namespace}/${t.metadata.name}`} />
                                ))}
                                {visibleClusterTemplates.map(t => (
                                    <WorkflowTemplateRow
                                        workflow={t}
                                        clusterScoped
                                        targetNamespace={namespace}
                                        displayISOFormat={storedDisplayISOFormat}
                                        key={`cluster/${t.metadata.name}`}
                                    />
                                ))}
                            </div>
                            <Footnote>
                                <InfoIcon /> Workflow templates are reusable templates you can create new workflows from. <ExampleManifests />. {learnMore}.
                            </Footnote>
                        </>
                    )}
                    {jobType !== 'cluster' && templates && !error && <PaginationPanel onChange={setPagination} pagination={pagination} numRecords={null} />}
                </div>
            </div>
            <AccessibleSlidingPanel isShown={sidePanel} onClose={() => setSidePanel(false)} closeLabel='Close create job template' isMiddle={!editorType}>
                {!editorType ? (
                    <div className='job-template-chooser'>
                        <h2>Create job template</h2>
                        <p>Choose the scope for your template. The list filter does not affect this choice.</p>
                        <fieldset>
                            <legend>Template type</legend>
                            <label className='job-template-chooser__option'>
                                <input
                                    type='radio'
                                    name='create-template-type'
                                    value='workflow'
                                    checked={selectedCreateType === 'workflow'}
                                    onChange={() => setSelectedCreateType('workflow')}
                                />
                                <span>
                                    <strong>Workflow template</strong>
                                    <small>Available in the selected namespace: {nsUtils.getNamespaceWithDefault(namespace)}.</small>
                                </span>
                            </label>
                            <label className='job-template-chooser__option'>
                                <input
                                    type='radio'
                                    name='create-template-type'
                                    value='cluster'
                                    checked={selectedCreateType === 'cluster'}
                                    onChange={() => setSelectedCreateType('cluster')}
                                />
                                <span>
                                    <strong>Cluster workflow template</strong>
                                    <small>Cluster-scoped; available across namespaces subject to permissions.</small>
                                </span>
                            </label>
                        </fieldset>
                        <button type='button' className='argo-button argo-button--base' disabled={!selectedCreateType} onClick={() => setEditorType(selectedCreateType)}>
                            Continue
                        </button>
                    </div>
                ) : editorType === 'workflow' ? (
                    <div className='job-template-editor'>
                        <h2 ref={editorHeadingRef} tabIndex={-1}>
                            Create workflow template
                        </h2>
                        <p>
                            Namespace: <strong>{nsUtils.getNamespaceWithDefault(namespace)}</strong>
                        </p>
                        <WorkflowTemplateCreator namespace={namespace} onCreate={wf => navigation.goto(uiUrl(`workflow-templates/${wf.metadata.namespace}/${wf.metadata.name}`))} />
                    </div>
                ) : (
                    <div className='job-template-editor'>
                        <h2 ref={editorHeadingRef} tabIndex={-1}>
                            Create cluster workflow template
                        </h2>
                        <p>
                            Scope: <strong>Cluster-wide</strong>
                        </p>
                        <ClusterWorkflowTemplateCreator onCreate={wf => navigation.goto(uiUrl(`cluster-workflow-templates/${wf.metadata.name}`))} />
                    </div>
                )}
            </AccessibleSlidingPanel>
        </Page>
    );
}
