import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useContext, useEffect, useMemo, useRef, useState} from 'react';
import {Link, RouteComponentProps} from 'react-router-dom';

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
import {formatDuration, wfDuration} from '../../../shared/duration';
import {downloadCsv, toCsv} from '../../../shared/export-csv';
import {historyUrl} from '../../../shared/history';
import {ListWatch, sortByYouth} from '../../../shared/list-watch';
import * as models from '../../../shared/models';
import {isArchivedWorkflow, Workflow, WorkflowPhase, WorkflowPhases} from '../../../shared/models';
import * as nsUtils from '../../../shared/namespaces';
import {Pagination, parseLimit} from '../../../shared/pagination';
import {SavedView, SavedViewsBar, viewKey} from '../../../shared/saved-views';
import {ScopedLocalStorage} from '../../../shared/scoped-local-storage';
import {services} from '../../../shared/services';
import {getStartedBy, startedByText} from '../../../shared/started-by';
import {useApprovalsCount} from '../../../shared/use-approvals-count';
import {useCollectEvent} from '../../../shared/use-collect-event';
import useTimestamp, {TIMESTAMP_KEYS} from '../../../shared/use-timestamp';
import * as Actions from '../../../shared/workflow-operations-map';
import {WorkflowCreator} from '../workflow-creator';
import {ARCHIVE_FILTERS, ArchiveFilter, matchesArchiveFilter, NAME_FILTER_KEYS, WorkflowFilters, type NameFilterKeys} from '../workflow-filters/workflow-filters';
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
const viewsStorage = new ScopedLocalStorage('WorkflowsListViews');

// built-in saved views, shown as chips above the filters (Temporal pattern)
const BUILT_IN_VIEWS: SavedView[] = [
    {name: 'Running', builtIn: true, filters: {phases: ['Running']}},
    {name: 'Failed', builtIn: true, filters: {phases: ['Failed', 'Error']}},
    {name: 'Succeeded', builtIn: true, filters: {phases: ['Succeeded']}},
    {name: 'Pending', builtIn: true, filters: {phases: ['Pending']}},
    // Runs held by a semaphore or mutex (Semaphore "waiting" queue): running
    // runs whose steps wait on a synchronization lock.
    {name: 'Queued', builtIn: true, filters: {phases: ['Running'], synchronization: 'waiting'}}
];

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
    const [nameValue, setNameValue] = useState<string>(() => {
        return queryParams.get(NAME_FILTER_KEYS.find(key => queryParams.get(key))) || '';
    });
    const [labelContains, setLabelContains] = useState(queryParams.get('labelContains') || '');
    const [nameFilter] = useState<NameFilterKeys>(() => NAME_FILTER_KEYS.find(key => queryParams.get(key)) || 'Contains');
    const [customViews, setCustomViews] = useState<SavedView[]>(() => viewsStorage.getItem('views', [] as SavedView[]));
    // '' shows everything; 'waiting' only runs whose steps wait on a
    // synchronization lock (semaphore or mutex).
    const [synchronization, setSynchronization] = useState<'' | 'waiting'>(queryParams.get('synchronization') === 'waiting' ? 'waiting' : '');

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
        const matching = (workflows || [])
            .filter(workflow => matchesArchiveFilter(workflow, archiveFilter))
            .filter(workflow => {
                if (synchronization !== 'waiting') {
                    return true;
                }
                const waiting = workflow.status?.synchronization?.semaphore?.waiting || workflow.status?.synchronization?.mutex?.waiting;
                return Object.keys(waiting || {}).length > 0;
            });
        return sortWorkflows(matching, sortColumn, sortDirection);
    }, [workflows, archiveFilter, sortColumn, sortDirection, synchronization]);
    const counts = countsByCompleted(visibleWorkflows);

    function clearSelectedWorkflows() {
        setSelectedWorkflows(new Map<string, models.Workflow>());
    }

    function resetFilteredList() {
        setPagination(current => ({...current, offset: undefined}));
        clearSelectedWorkflows();
    }

    const hasActiveFilters = !!(
        nameValue ||
        labelContains ||
        labels.length > 0 ||
        phases.length > 0 ||
        createdAfter ||
        finishedBefore ||
        archiveFilter !== 'all' ||
        synchronization !== ''
    );

    // saved views: the current filter combination, canonically serialized
    const currentFilters = {
        phases,
        labels,
        nameValue: nameValue || undefined,
        labelContains: labelContains || undefined,
        createdAfter: createdAfter?.toISOString(),
        finishedBefore: finishedBefore?.toISOString(),
        archiveFilter: archiveFilter === 'all' ? undefined : archiveFilter,
        synchronization: synchronization || undefined
    };
    const currentViewKey = viewKey(currentFilters);

    function applyView(view: SavedView) {
        const filters = view.filters;
        setPhases(((filters.phases as string[]) || []).slice() as WorkflowPhase[]);
        setLabels(((filters.labels as string[]) || []).slice());
        setNameValue((filters.nameValue as string) || '');
        setLabelContains((filters.labelContains as string) || '');
        setCreatedAfter(filters.createdAfter ? new Date(filters.createdAfter as string) : undefined);
        setFinishedBefore(filters.finishedBefore ? new Date(filters.finishedBefore as string) : undefined);
        setArchiveFilter((filters.archiveFilter as ArchiveFilter) || 'all');
        setSynchronization(filters.synchronization === 'waiting' ? 'waiting' : '');
        resetFilteredList();
    }

    function saveView(name: string) {
        const next = customViews.filter(view => view.name !== name).concat({name, filters: currentFilters});
        viewsStorage.setItem('views', next, [] as SavedView[]);
        setCustomViews(next);
    }

    function deleteView(view: SavedView) {
        const next = customViews.filter(item => item.name !== view.name);
        viewsStorage.setItem('views', next, [] as SavedView[]);
        setCustomViews(next);
    }

    // Rundeck-style activity export
    function exportCsv() {
        const headers = ['name', 'namespace', 'status', 'started', 'finished', 'duration', 'progress', 'started by', 'message'];
        const rows = visibleWorkflows.map(wf => [
            wf.metadata.name,
            wf.metadata.namespace,
            wf.status?.phase || '',
            wf.status?.startedAt || '',
            wf.status?.finishedAt || '',
            wf.status?.startedAt ? formatDuration(wfDuration(wf.status)) : '',
            wf.status?.progress || '',
            startedByText(getStartedBy(wf)),
            wf.status?.message || ''
        ]);
        downloadCsv(`runs-${namespace || 'all'}.csv`, toCsv(headers, rows));
    }

    function clearFilters() {
        setNamespace(nsUtils.getNamespace(match.params.namespace) || '');
        setPhases([]);
        setLabels([]);
        setCreatedAfter(undefined);
        setFinishedBefore(undefined);
        setArchiveFilter('all');
        setNameValue('');
        setLabelContains('');
        setSynchronization('');
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
        if (synchronization === 'waiting') {
            params.append('synchronization', 'waiting');
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
        synchronization,
        createdAfter,
        finishedBefore,
        archiveFilter,
        sidePanel
    ]); // referential equality, so use values, not refs

    useEffect(() => {
        const nameTitleContains = nameFilter === 'Contains' ? nameValue.trim() : '';
        const labelTerm = labelContains.trim();
        const searching = !!(nameTitleContains || labelTerm);
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        setWorkflows(undefined);
        const list = () =>
            services.workflows.list(
                namespace,
                phases,
                labels,
                searching && !pagination.limit ? {...pagination, limit: 100} : pagination,
                undefined,
                nameTitleContains ? undefined : nameValue,
                nameFilter,
                createdAfter,
                finishedBefore,
                archiveFilter,
                searching ? {nameTitleContains, labelContains: labelTerm} : undefined
            );
        const onLoad = (metadata: {continue?: string}) => {
            setError(null);
            setPagination(current => ({...current, nextOffset: metadata?.continue}));
            clearSelectedWorkflows();
        };

        if (searching) {
            // Refresh the matching page. Merging an unfiltered watch could insert
            // non-matches and displace rows across page boundaries.
            const refresh = async () => {
                try {
                    const page = await list();
                    if (!cancelled) {
                        onLoad(page.metadata);
                        setWorkflows([...(page.items || [])]);
                    }
                } catch (err) {
                    if (!cancelled) setError(err);
                } finally {
                    if (!cancelled) timer = setTimeout(refresh, 15000);
                }
            };
            timer = setTimeout(refresh, 250);
            return () => {
                cancelled = true;
                clearTimeout(timer);
                clearSelectedWorkflows();
            };
        }

        const listWatch = new ListWatch(
            list,
            (resourceVersion: string) => services.workflows.watchFields({namespace, phases, labels, resourceVersion, archiveFilter}),
            onLoad,
            () => setError(null),
            newWorkflows => setWorkflows([...newWorkflows]),
            err => setError(err),
            sortByYouth
        );
        listWatch.start();
        return () => {
            clearSelectedWorkflows();
            listWatch.stop();
        };
    }, [namespace, phases.toString(), labels.toString(), pagination.limit, pagination.offset, nameValue, nameFilter, labelContains, createdAfter, finishedBefore, archiveFilter]); // referential equality, so use values, not refs

    useCollectEvent('openedWorkflowList');

    // Approvals live on the Runs page: the strip counts suspended steps of
    // running runs (sharing the nav item's poll) and links to the approvals
    // queue.
    const approvalsCount = useApprovalsCount(namespace);

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
            {approvalsCount !== undefined && approvalsCount > 0 && (
                <div className='workflows-list__approvals-strip' role='status'>
                    <i className='fa fa-user-check' aria-hidden='true' />
                    <span>
                        {approvalsCount} {approvalsCount === 1 ? 'step is' : 'steps are'} waiting for your approval
                    </span>
                    <Link to={uiUrl(namespace ? `approvals/${namespace}` : 'approvals')}>Review</Link>
                </div>
            )}
            <WorkflowsToolbar
                selectedWorkflows={selectedWorkflows}
                clearSelection={clearSelectedWorkflows}
                disabledActions={batchActionDisabled}
                loadWorkflows={clearSelectedWorkflows}
            />
            <div className={`workflows-list__body ${selectedWorkflows.size === 0 ? '' : 'pt-60'}`}>
                <div className='workflows-list__controls'>
                    <div className='workflows-list__view-controls'>
                        <SavedViewsBar views={BUILT_IN_VIEWS.concat(customViews)} currentKey={currentViewKey} onApply={applyView} onSave={saveView} onDelete={deleteView} />
                        <button
                            type='button'
                            className={`argo-button argo-button--base-o workflows-list__queued-toggle ${synchronization === 'waiting' ? 'active' : ''}`}
                            aria-pressed={synchronization === 'waiting'}
                            title='Only show runs whose steps wait on a semaphore or mutex'
                            onClick={() => {
                                setSynchronization(current => (current === 'waiting' ? '' : 'waiting'));
                                resetFilteredList();
                            }}>
                            <i className='fa fa-hourglass-half' aria-hidden='true' /> Queued only
                        </button>
                    </div>
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
                    {!workflows ? (
                        !error && (
                            <>
                                {((nameFilter === 'Contains' && nameValue.trim()) || labelContains.trim()) && <p role='status'>Searching runs...</p>}
                                <Loading />
                            </>
                        )
                    ) : visibleWorkflows.length === 0 ? (
                        <ZeroState title={hasActiveFilters ? 'No matching runs' : 'No runs'}>
                            {hasActiveFilters ? (
                                <>
                                    <p>Try changing your filters or clear them to see all runs.</p>
                                    <button type='button' className='argo-button argo-button--base-o' onClick={clearFilters}>
                                        Clear all
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
                                <button type='button' className='argo-button argo-button--base-o' onClick={exportCsv} title='Export the filtered runs to a CSV file'>
                                    <i className='fa fa-download' aria-hidden='true' /> Export CSV
                                </button>
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
                                            {visibleColumns.includes('startedBy') && (
                                                <div className='columns small-1' role='columnheader'>
                                                    STARTED BY
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
