import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useContext, useEffect, useMemo, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router-dom';

import {uiUrl} from '../../../shared/base';
import {AccessibleSlidingPanel} from '../../../shared/components/accessible-sliding-panel';
import {CostOptimisationNudge} from '../../../shared/components/cost-optimisation-nudge';
import {ErrorNotice} from '../../../shared/components/error-notice';
import {ExampleManifests} from '../../../shared/components/example-manifests';
import {openLinkWithKey} from '../../../shared/components/links';
import {Loading} from '../../../shared/components/loading';
import {PaginationPanel} from '../../../shared/components/pagination-panel';
import {TimestampSwitch} from '../../../shared/components/timestamp';
import {ZeroState} from '../../../shared/components/zero-state';
import {Context} from '../../../shared/context';
import {historyUrl} from '../../../shared/history';
import {ListWatch, sortByYouth} from '../../../shared/list-watch';
import * as models from '../../../shared/models';
import {isArchivedWorkflow, Workflow, WorkflowPhase, WorkflowPhases} from '../../../shared/models';
import {fetchAllPages, matchesLabelContains, matchesWorkflowName, searchPageOffset} from '../../../shared/name-title-search';
import * as nsUtils from '../../../shared/namespaces';
import {Pagination, parseLimit} from '../../../shared/pagination';
import {ScopedLocalStorage} from '../../../shared/scoped-local-storage';
import {services} from '../../../shared/services';
import {useCollectEvent} from '../../../shared/use-collect-event';
import useTimestamp, {TIMESTAMP_KEYS} from '../../../shared/use-timestamp';
import * as Actions from '../../../shared/workflow-operations-map';
import {WorkflowCreator} from '../workflow-creator';
import {
    ARCHIVE_FILTERS,
    ArchiveFilter,
    matchesArchiveFilter,
    matchesWorkflowDates,
    NAME_FILTER_KEYS,
    WorkflowFilters,
    type NameFilterKeys
} from '../workflow-filters/workflow-filters';
import {WorkflowsRow} from '../workflows-row/workflows-row';
import {WorkflowsSummaryContainer} from '../workflows-summary-container/workflows-summary-container';
import {WorkflowsToolbar} from '../workflows-toolbar/workflows-toolbar';
import {OPTIONAL_COLUMNS, OptionalColumn, SortColumn, SortDirection, sortWorkflows} from './table-options';

import './workflows-list.scss';

import {useQueryParams} from '../../../shared/use-query-params';

interface WorkflowListRenderOptions {
    paginationLimit: number;
    phases: WorkflowPhase[];
    labels: string[];
    name: string;
    namePrefix: string;
    namePattern: string;
}

const actions = Actions.WorkflowOperationsMap;
const allBatchActionsEnabled: Actions.OperationDisabled = {
    RETRY: false,
    RESUBMIT: false,
    SUSPEND: false,
    RESUME: false,
    STOP: false,
    TERMINATE: false,
    DELETE: false
};

const storage = new ScopedLocalStorage('ListOptions');

export function WorkflowsList({match, location, history}: RouteComponentProps<any>) {
    const queryParams = new URLSearchParams(location.search);
    const {navigation} = useContext(Context);

    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [sidePanel, setSidePanel] = useState(queryParams.get('sidePanel') || '');
    const [pagination, setPagination] = useState<Pagination>(() => {
        const savedPaginationLimit = storage.getItem('options', {}).paginationLimit;
        return {
            offset: queryParams.get('offset') || undefined,
            limit: parseLimit(queryParams.get('limit')) ?? savedPaginationLimit ?? 50
        };
    });
    const [phases, setPhases] = useState<WorkflowPhase[]>(() => {
        const savedOptions = storage.getItem('options', {});
        // selectedPhases is a legacy name, used here for backward-compat with old storage
        const savedPhases = savedOptions.phases || savedOptions.selectedPhases || [];
        const phaseQueryParam = queryParams.getAll('phase') as WorkflowPhase[];
        return phaseQueryParam.length > 0 ? phaseQueryParam : savedPhases;
    });
    const [labels, setLabels] = useState<string[]>(() => {
        const savedOptions = storage.getItem('options', {});
        // selectedLabels is a legacy name, used here for backward-compat with old storage
        const savedLabels = savedOptions.labels || savedOptions.selectedLabels || [];
        const labelQueryParam = queryParams.getAll('label');
        return labelQueryParam.length > 0 ? labelQueryParam : savedLabels;
    });
    const [createdAfter, setCreatedAfter] = useState<Date>();
    const [finishedBefore, setFinishedBefore] = useState<Date>();
    const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>(() => {
        const queryValue = queryParams.get('archive');
        return ARCHIVE_FILTERS.some(item => item.id === queryValue) ? (queryValue as ArchiveFilter) : 'all';
    });
    const [selectedWorkflows, setSelectedWorkflows] = useState(new Map<string, models.Workflow>());
    const [sortColumn, setSortColumn] = useState<SortColumn>('started');
    const [sortDirection, setSortDirection] = useState<SortDirection>('descending');
    const [visibleColumns, setVisibleColumns] = useState<OptionalColumn[]>(() => {
        const saved = storage.getItem('visibleColumns', OPTIONAL_COLUMNS as readonly string[]);
        return Array.isArray(saved) ? OPTIONAL_COLUMNS.filter(column => saved.includes(column)) : [...OPTIONAL_COLUMNS];
    });
    useEffect(() => storage.setItem('visibleColumns', visibleColumns, [...OPTIONAL_COLUMNS]), [visibleColumns]);
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [links, setLinks] = useState<models.Link[]>([]);
    const [columns, setColumns] = useState<models.Column[]>([]);
    const [error, setError] = useState<Error>();
    const [searchTruncated, setSearchTruncated] = useState(false);
    const [nameValue, setNameValue] = useState<string>(() => {
        return queryParams.get(NAME_FILTER_KEYS.find(key => queryParams.get(key))) || '';
    });
    const [labelContains, setLabelContains] = useState(queryParams.get('labelContains') || '');
    const [nameFilter] = useState<NameFilterKeys>(() => NAME_FILTER_KEYS.find(key => queryParams.get(key)) || 'Contains');

    const batchActionDisabled = useMemo<Actions.OperationDisabled>(() => {
        const nowDisabled: any = {...allBatchActionsEnabled};
        for (const action of Object.keys(nowDisabled)) {
            for (const wf of Array.from(selectedWorkflows.values())) {
                nowDisabled[action] = nowDisabled[action] || actions[action].disabled(wf);
            }
        }
        return nowDisabled;
    }, [selectedWorkflows]);

    const visibleWorkflows = useMemo<Workflow[]>(() => {
        const matching = (workflows || []).filter(workflow => matchesArchiveFilter(workflow, archiveFilter));
        return sortWorkflows(matching, sortColumn, sortDirection);
    }, [workflows, archiveFilter, sortColumn, sortDirection]);
    const counts = countsByCompleted(visibleWorkflows);

    function clearSelectedWorkflows() {
        setSelectedWorkflows(new Map<string, models.Workflow>());
    }

    function resetFilteredList() {
        setPagination(current => ({...current, offset: undefined}));
        clearSelectedWorkflows();
    }

    const hasActiveFilters = !!(nameValue || labelContains || labels.length > 0 || phases.length > 0 || createdAfter || finishedBefore || archiveFilter !== 'all');

    function clearFilters() {
        setNamespace(nsUtils.getNamespace(match.params.namespace) || '');
        setPhases([]);
        setLabels([]);
        setCreatedAfter(undefined);
        setFinishedBefore(undefined);
        setArchiveFilter('all');
        setNameValue('');
        setLabelContains('');
        setPagination(current => ({...current, offset: undefined}));
        clearSelectedWorkflows();
    }

    // run once on first render
    useEffect(() => {
        (async () => {
            const info = await services.info.getInfo();
            setLinks((info.links || []).filter(link => link.scope === 'workflow-list'));
            setColumns(info.columns);
        })();
    }, []);

    useEffect(
        useQueryParams(history, p => {
            setSidePanel(p.get('sidePanel') || '');
        }),
        [history]
    );

    // save history and localStorage
    useEffect(() => {
        // add empty selectedPhases + selectedLabels for forward-compat w/ old version: previous code relies on them existing, so if you move up a version and back down, it breaks
        const options = {selectedPhases: [], selectedLabels: []} as unknown as WorkflowListRenderOptions;
        options.phases = phases;
        options.labels = labels;
        if (pagination.limit !== undefined) {
            options.paginationLimit = pagination.limit;
        }
        storage.setItem('options', options, {} as WorkflowListRenderOptions);

        const params = new URLSearchParams();
        const currentParams = new URLSearchParams(history.location.search);

        if (currentParams.has('namespace')) {
            params.set('namespace', currentParams.get('namespace'));
        }

        if (sidePanel) {
            params.set('sidePanel', sidePanel);

            // preserve template name and parameters if sidePanel is open
            if (currentParams.has('template')) {
                params.append('template', currentParams.get('template'));
            }
            if (currentParams.has('templateKind')) {
                params.append('templateKind', currentParams.get('templateKind'));
            }
            currentParams.forEach((v, k) => {
                if (k.startsWith('parameters')) {
                    params.append(k, v);
                }
            });
        }

        // phases
        phases?.forEach(phase => params.append('phase', phase));
        labels?.forEach(label => params.append('label', label));
        if (pagination.offset) {
            params.append('offset', pagination.offset);
        }
        if (pagination.limit !== undefined) {
            params.append('limit', pagination.limit.toString());
        }
        if (nameValue) {
            params.append(nameFilter, nameValue);
        }
        if (labelContains) params.set('labelContains', labelContains);
        if (createdAfter) {
            params.append('createdAfter', createdAfter.toISOString());
        }
        if (finishedBefore) {
            params.append('finishedBefore', finishedBefore.toISOString());
        }
        if (archiveFilter !== 'all') {
            params.append('archive', archiveFilter);
        }
        (isFirstRender.current ? history.replace : history.push)(
            historyUrl('workflows' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace, extraSearchParams: params})
        );
        isFirstRender.current = false;
    }, [
        namespace,
        phases.toString(),
        labels.toString(),
        pagination.limit,
        pagination.offset,
        nameValue,
        nameFilter,
        labelContains,
        createdAfter,
        finishedBefore,
        archiveFilter,
        sidePanel
    ]); // referential equality, so use values, not refs

    useEffect(() => {
        const searchAll = (nameFilter === 'Contains' && !!nameValue.trim()) || !!labelContains.trim();
        let cancelled = false;
        setWorkflows(undefined);
        setSearchTruncated(false);
        const listWatch = new ListWatch(
            () =>
                searchAll
                    ? fetchAllPages(page => {
                          if (cancelled) return Promise.reject(new Error('Search cancelled'));
                          return services.workflows.list(
                              namespace,
                              phases,
                              labels,
                              {...page, includeRemainingItemCount: true},
                              undefined,
                              nameFilter === 'Contains' ? '' : nameValue,
                              nameFilter,
                              createdAfter,
                              finishedBefore,
                              archiveFilter
                          );
                      })
                    : services.workflows.list(
                          namespace,
                          phases,
                          labels,
                          pagination,
                          undefined,
                          nameFilter === 'Contains' ? nameValue.trim() : nameValue,
                          nameFilter,
                          createdAfter,
                          finishedBefore,
                          archiveFilter
                      ),
            (resourceVersion: string) => services.workflows.watchFields({namespace, phases, labels, resourceVersion, archiveFilter}),
            metadata => {
                setSearchTruncated(searchAll && !!(metadata as typeof metadata & {scanTruncated?: boolean}).scanTruncated);
                setError(null);
                if (!searchAll) setPagination({...pagination, nextOffset: metadata.continue});
                clearSelectedWorkflows();
            },
            () => setError(null),
            newWorkflows => {
                if (!searchAll) {
                    setWorkflows([...newWorkflows]);
                    return;
                }
                const matching = newWorkflows.filter(
                    workflow =>
                        matchesWorkflowName(workflow, nameValue, nameFilter) &&
                        matchesLabelContains(workflow, labelContains) &&
                        matchesArchiveFilter(workflow, archiveFilter) &&
                        matchesWorkflowDates(workflow, createdAfter, finishedBefore)
                );
                const offset = searchPageOffset(pagination.offset);
                if (offset > 0 && offset >= matching.length) {
                    setPagination(current => ({...current, offset: undefined, nextOffset: undefined}));
                    return;
                }
                const end = pagination.limit > 0 ? offset + pagination.limit : matching.length;
                setPagination(current => ({...current, nextOffset: end < matching.length ? `search:${end}` : undefined}));
                setWorkflows(matching.slice(offset, end));
            },
            err => setError(err),
            sortByYouth
        );
        listWatch.start();

        return () => {
            cancelled = true;
            clearSelectedWorkflows();
            listWatch.stop();
        };
    }, [namespace, phases.toString(), labels.toString(), pagination.limit, pagination.offset, nameValue, nameFilter, labelContains, createdAfter, finishedBefore, archiveFilter]); // referential equality, so use values, not refs

    useCollectEvent('openedWorkflowList');

    const [storedDisplayISOFormatStart, setStoredDisplayISOFormatStart] = useTimestamp(TIMESTAMP_KEYS.WORKFLOWS_ROW_STARTED);
    const [storedDisplayISOFormatFinished, setStoredDisplayISOFormatFinished] = useTimestamp(TIMESTAMP_KEYS.WORKFLOWS_ROW_FINISHED);

    return (
        <Page
            title='Runs'
            toolbar={{
                breadcrumbs: [
                    {title: 'Runs', path: uiUrl('workflows')},
                    {title: namespace, path: uiUrl('workflows/' + namespace)}
                ],
                actionMenu: {
                    items: [
                        {
                            title: 'Run job',
                            iconClassName: 'fa fa-plus',
                            action: () => setSidePanel('submit-new-workflow')
                        },
                        ...links.map(link => ({
                            title: link.name,
                            iconClassName: 'fa fa-external-link',
                            action: () => openLinkWithKey(link.url, link.target)
                        }))
                    ]
                }
            }}>
            <h1 className='modern-visually-hidden'>Runs</h1>
            <WorkflowsToolbar
                selectedWorkflows={selectedWorkflows}
                clearSelection={clearSelectedWorkflows}
                disabledActions={batchActionDisabled}
                loadWorkflows={clearSelectedWorkflows}
            />
            <div className={`workflows-list__body ${selectedWorkflows.size === 0 ? '' : 'pt-60'}`}>
                <div className='workflows-list__controls'>
                    <WorkflowsSummaryContainer
                        workflows={workflows}
                        selectedPhases={phases}
                        onSelectPhase={phase => {
                            setPhases(current => (current.length === 1 && current[0] === phase ? [] : [phase]));
                            resetFilteredList();
                        }}
                    />
                    <WorkflowFilters
                        workflows={workflows || []}
                        namespace={namespace}
                        phaseItems={WorkflowPhases}
                        phases={phases}
                        labels={labels}
                        createdAfter={createdAfter}
                        finishedBefore={finishedBefore}
                        archiveFilter={archiveFilter}
                        setArchiveFilter={value => {
                            setArchiveFilter(value);
                            resetFilteredList();
                        }}
                        setNamespace={value => {
                            setNamespace(value);
                            resetFilteredList();
                        }}
                        setPhases={value => {
                            setPhases(value);
                            resetFilteredList();
                        }}
                        setLabels={value => {
                            setLabels(value);
                            resetFilteredList();
                        }}
                        setCreatedAfter={(date: Date) => {
                            setCreatedAfter(date);
                            resetFilteredList();
                        }}
                        setFinishedBefore={(date: Date) => {
                            setFinishedBefore(date);
                            resetFilteredList();
                        }}
                        nameValue={nameValue}
                        labelContains={labelContains}
                        setLabelContains={value => {
                            setLabelContains(value);
                            resetFilteredList();
                        }}
                        setNameValue={value => {
                            setNameValue(value);
                            resetFilteredList();
                        }}
                        clearFilters={clearFilters}
                    />
                </div>
                <div className='workflows-list__results'>
                    <ErrorNotice error={error} />
                    {searchTruncated && <p role='status'>Search scanned the first 2,000 runs only. Refine your search to find other matches.</p>}
                    {!workflows ? (
                        !error && (
                            <>
                                {((nameFilter === 'Contains' && nameValue.trim()) || labelContains.trim()) && <p role='status'>Searching the first 2,000 runs...</p>}
                                <Loading />
                            </>
                        )
                    ) : visibleWorkflows.length === 0 ? (
                        <ZeroState title={hasActiveFilters ? 'No matching runs' : 'No runs'}>
                            {hasActiveFilters ? (
                                <>
                                    <p>Try changing your filters or clear them to see all runs.</p>
                                    <button type='button' className='argo-button argo-button--base-o' onClick={clearFilters}>
                                        Clear filters
                                    </button>
                                </>
                            ) : (
                                <>
                                    <p>To start a run, use the button above.</p>
                                    <p>
                                        <ExampleManifests />.
                                    </p>
                                </>
                            )}
                        </ZeroState>
                    ) : (
                        <>
                            {(counts.complete > 100 || counts.incomplete > 100) && (
                                <CostOptimisationNudge name='workflow-list'>
                                    You have at least {counts.incomplete} incomplete and {counts.complete} complete workflows. Reducing these amounts will reduce your costs.
                                </CostOptimisationNudge>
                            )}
                            <p role='status'>
                                {visibleWorkflows.length} runs shown {pagination.limit === 0 ? 'from loaded results' : 'on this page'}
                            </p>
                            <div className='workflows-list__table-options'>
                                <div className='workflows-list__sort'>
                                    <label htmlFor='runs-sort'>Sort by</label>
                                    <select
                                        id='runs-sort'
                                        className='argo-field'
                                        aria-describedby='runs-sort-scope'
                                        value={`${sortColumn}:${sortDirection}`}
                                        onChange={event => {
                                            const [column, direction] = event.target.value.split(':');
                                            setSortColumn(column as SortColumn);
                                            setSortDirection(direction as SortDirection);
                                        }}>
                                        <option value='started:descending'>Started: newest first</option>
                                        <option value='started:ascending'>Started: oldest first</option>
                                        <option value='finished:descending'>Finished: newest first</option>
                                        <option value='finished:ascending'>Finished: oldest first</option>
                                        <option value='name:ascending'>Name: A to Z</option>
                                        <option value='name:descending'>Name: Z to A</option>
                                        <option value='status:ascending'>Status: A to Z</option>
                                        <option value='status:descending'>Status: Z to A</option>
                                    </select>
                                    <small id='runs-sort-scope' className='workflows-list__scope'>
                                        {pagination.limit === 0 ? 'Sorts all loaded results' : 'Sorts this page only'}
                                    </small>
                                </div>
                                <details>
                                    <summary>Choose columns</summary>
                                    <fieldset>
                                        <legend>Visible desktop columns</legend>
                                        {OPTIONAL_COLUMNS.map(column => (
                                            <label key={column}>
                                                <input
                                                    type='checkbox'
                                                    checked={visibleColumns.includes(column)}
                                                    onChange={event =>
                                                        setVisibleColumns(current => (event.target.checked ? [...current, column] : current.filter(item => item !== column)))
                                                    }
                                                />{' '}
                                                {column}
                                            </label>
                                        ))}
                                    </fieldset>
                                </details>
                            </div>
                            <div className='argo-table-list workflows-table' role='table' aria-label='Runs'>
                                <div className='workflows-table__content'>
                                    <div className='row argo-table-list__head workflows-table__head' role='row'>
                                        <div className='columns small-1 workflows-list__status' role='columnheader'>
                                            <input
                                                type='checkbox'
                                                aria-label='Select all visible workflows'
                                                className='workflows-list__status--checkbox'
                                                checked={visibleWorkflows.length > 0 && visibleWorkflows.every(wf => !!wf.metadata.uid && selectedWorkflows.has(wf.metadata.uid))}
                                                onClick={e => {
                                                    e.stopPropagation();
                                                }}
                                                onChange={() => {
                                                    const newSelections = new Map<string, models.Workflow>();
                                                    // Not all workflows are selected, select them all
                                                    if (!visibleWorkflows.every(wf => !!wf.metadata.uid && selectedWorkflows.has(wf.metadata.uid))) {
                                                        visibleWorkflows.forEach(wf => {
                                                            if (wf.metadata.uid) newSelections.set(wf.metadata.uid, wf);
                                                        });
                                                    }
                                                    setSelectedWorkflows(newSelections);
                                                }}
                                            />
                                        </div>
                                        <div className='row small-11'>
                                            <div className='columns small-2' role='columnheader'>
                                                NAME AND STATUS
                                            </div>
                                            {visibleColumns.includes('namespace') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    NAMESPACE
                                                </div>
                                            )}
                                            {visibleColumns.includes('started') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    STARTED{' '}
                                                    <TimestampSwitch
                                                        storedDisplayISOFormat={storedDisplayISOFormatStart}
                                                        setStoredDisplayISOFormat={setStoredDisplayISOFormatStart}
                                                    />
                                                </div>
                                            )}
                                            {visibleColumns.includes('finished') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    FINISHED{' '}
                                                    <TimestampSwitch
                                                        storedDisplayISOFormat={storedDisplayISOFormatFinished}
                                                        setStoredDisplayISOFormat={setStoredDisplayISOFormatFinished}
                                                    />
                                                </div>
                                            )}
                                            {visibleColumns.includes('duration') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    DURATION
                                                </div>
                                            )}
                                            {visibleColumns.includes('progress') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    PROGRESS
                                                </div>
                                            )}
                                            {visibleColumns.includes('message') && (
                                                <div className='columns small-2' role='columnheader'>
                                                    MESSAGE
                                                </div>
                                            )}
                                            {visibleColumns.includes('details') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    DETAILS
                                                </div>
                                            )}
                                            {visibleColumns.includes('archived') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    ARCHIVED
                                                </div>
                                            )}
                                            {(columns || []).map(col => {
                                                return (
                                                    <div className='columns small-1' key={col.key} role='columnheader'>
                                                        {col.name}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    {visibleWorkflows.map(wf => {
                                        return (
                                            <WorkflowsRow
                                                workflow={wf}
                                                key={wf.metadata.uid}
                                                checked={selectedWorkflows.has(wf.metadata.uid)}
                                                columns={columns}
                                                visibleColumns={visibleColumns}
                                                onChange={key => {
                                                    const value = `${key}=${wf.metadata?.labels[key]}`;
                                                    let newLabels: string[];
                                                    // add or remove the label if it is selected
                                                    if (!labels.includes(value)) {
                                                        newLabels = labels.concat(value);
                                                    } else {
                                                        newLabels = labels.filter(tag => tag !== value);
                                                    }
                                                    setLabels(newLabels);
                                                }}
                                                select={() => {
                                                    const wfUID = wf.metadata.uid;
                                                    if (!wfUID) {
                                                        return;
                                                    }
                                                    const newSelections = new Map<string, models.Workflow>();
                                                    selectedWorkflows.forEach((v, k) => newSelections.set(k, v)); // clone the Map
                                                    // add or delete it in the new Map
                                                    if (!newSelections.has(wfUID)) {
                                                        newSelections.set(wfUID, wf);
                                                    } else {
                                                        newSelections.delete(wfUID);
                                                    }
                                                    setSelectedWorkflows(newSelections);
                                                }}
                                                displayISOFormatStart={storedDisplayISOFormatStart}
                                                displayISOFormatFinished={storedDisplayISOFormatFinished}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}
                    {workflows && <PaginationPanel onChange={setPagination} pagination={pagination} numRecords={visibleWorkflows.length} />}
                </div>
            </div>
            <AccessibleSlidingPanel isShown={!!sidePanel} isMiddle closeLabel='Close run job panel' onClose={() => setSidePanel('')}>
                {sidePanel === 'submit-new-workflow' && (
                    <WorkflowCreator
                        namespace={nsUtils.getNamespaceWithDefault(namespace)}
                        history={history}
                        onCreate={wf => navigation.goto(uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}`))}
                    />
                )}
            </AccessibleSlidingPanel>
        </Page>
    );
}

function countsByCompleted(workflows?: Workflow[]) {
    const counts = {complete: 0, incomplete: 0};
    (workflows || []).forEach(wf => {
        // don't count archived workflows as this is for GC purposes
        if (isArchivedWorkflow(wf)) {
            return;
        }

        if (wf.metadata?.labels?.[models.labels.completed] === 'true') {
            counts.complete++;
        } else {
            counts.incomplete++;
        }
    });
    return counts;
}
