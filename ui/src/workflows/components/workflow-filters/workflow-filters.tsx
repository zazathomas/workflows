import classNames from 'classnames';
import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';
import DatePicker from 'react-datepicker';

import 'react-datepicker/dist/react-datepicker.css';

import {CheckboxFilter} from '../../../shared/components/checkbox-filter/checkbox-filter';
import {DataLoaderDropdown} from '../../../shared/components/data-loader-dropdown';
import {NamespaceFilter} from '../../../shared/components/namespace-filter';
import {SEARCH_MODE_OPTIONS, SearchModeFilter} from '../../../shared/components/search-mode-filter';
import * as models from '../../../shared/models';
import {WorkflowPhase} from '../../../shared/models';
import {getUniqueNamespaces} from '../../../shared/namespaces';
import {services} from '../../../shared/services';

import './workflow-filters.scss';

export const NAME_FILTERS = [{title: 'Name or title contains', id: 'Contains' as const}];

export const NAME_FILTER_KEYS = NAME_FILTERS.map(item => item.id);
export type NameFilterKeys = (typeof NAME_FILTER_KEYS)[number];

export const ARCHIVE_FILTERS = [
    {title: 'All runs', id: 'all'},
    {title: 'Live runs', id: 'live'},
    {title: 'Archived runs', id: 'archived'}
] as const;

export type ArchiveFilter = (typeof ARCHIVE_FILTERS)[number]['id'];

export function matchesArchiveFilter(workflow: models.Workflow, archiveFilter: ArchiveFilter) {
    return archiveFilter === 'all' || (archiveFilter === 'archived' ? models.isArchivedWorkflow(workflow) : !models.isArchivedWorkflow(workflow));
}

export function matchesWorkflowDates(workflow: models.Workflow, createdAfter?: Date, finishedBefore?: Date) {
    const created = workflow.metadata.creationTimestamp && new Date(workflow.metadata.creationTimestamp).getTime();
    const finished = workflow.status?.finishedAt && new Date(workflow.status.finishedAt).getTime();
    return (!createdAfter || (!!created && created >= createdAfter.getTime())) && (!finishedBefore || (!!finished && finished <= finishedBefore.getTime()));
}

interface WorkflowFilterProps {
    workflows: models.Workflow[];
    namespace: string;
    phaseItems: WorkflowPhase[];
    phases: WorkflowPhase[];
    labels: string[];
    createdAfter?: Date;
    finishedBefore?: Date;
    archiveFilter: ArchiveFilter;
    setArchiveFilter: (archiveFilter: ArchiveFilter) => void;
    setNamespace: (namespace: string) => void;
    setPhases: (phases: WorkflowPhase[]) => void;
    setLabels: (labels: string[]) => void;
    setCreatedAfter: (createdAfter: Date) => void;
    setFinishedBefore: (finishedBefore: Date) => void;
    nameValue: string;
    labelContains: string;
    setLabelContains: (value: string) => void;
    setNameValue: (nameValue: string) => void;
    clearFilters: () => void;
}

export function WorkflowFilters(props: WorkflowFilterProps) {
    const [filterMode, setFilterMode] = useState<'name' | 'team' | 'label'>(() => (props.labelContains && !props.nameValue ? 'label' : 'name'));
    const activeFilterCount = [
        props.nameValue,
        props.labelContains,
        props.labels.length > 0,
        props.phases.length > 0,
        props.createdAfter,
        props.finishedBefore,
        props.archiveFilter !== 'all'
    ].filter(Boolean).length;
    const advancedFilterCount = [props.phases.length > 0, props.createdAfter, props.finishedBefore].filter(Boolean).length;
    const [showAdvancedFilters, setShowAdvancedFilters] = useState(advancedFilterCount > 0);

    useEffect(() => {
        if (advancedFilterCount > 0) {
            setShowAdvancedFilters(true);
        }
    }, [advancedFilterCount]);

    function setLabel(name: string, value: string) {
        const otherLabels = props.labels.filter(label => !label.startsWith(`${name}=`));
        props.setLabels(value ? [...otherLabels, `${name}=${value}`] : otherLabels);
    }

    function labelValue(name: string) {
        const prefix = `${name}=`;
        return props.labels.find(label => label.startsWith(prefix))?.slice(prefix.length) || '';
    }

    function setWorkflowTemplate(value: string) {
        setLabel(models.labels.workflowTemplate, value);
    }

    function setCronWorkflow(value: string) {
        setLabel(models.labels.cronWorkflow, value);
    }

    const phaseItems = useMemo(() => {
        const phasesMap = new Map<string, number>();
        props.phaseItems.forEach(value => phasesMap.set(value, 0));
        props.workflows.filter(wf => wf.status.phase).forEach(wf => phasesMap.set(wf.status.phase, (phasesMap.get(wf.status.phase) || 0) + 1));
        return Array.from(phasesMap).map(([name, count]) => ({name, count}));
    }, [props.workflows, props.phaseItems]);

    return (
        <section className={classNames('wf-filters-container', {'wf-filters-container--show-secondary': showAdvancedFilters})} aria-labelledby='workflow-filters-heading'>
            <div className='wf-filters-container__header'>
                <div className='wf-filters-container__heading-group'>
                    <h2 id='workflow-filters-heading' className='wf-filters-container__heading'>
                        Filters
                    </h2>
                    {activeFilterCount > 0 && <span className='wf-filters-container__count'>{activeFilterCount} active</span>}
                </div>
                <div className='wf-filters-container__actions'>
                    {activeFilterCount > 0 && (
                        <button type='button' className='wf-filters-container__clear' onClick={props.clearFilters}>
                            Clear all
                        </button>
                    )}
                    <button
                        type='button'
                        className='argo-button argo-button--base-o wf-filters-container__more'
                        aria-expanded={showAdvancedFilters}
                        aria-controls='workflow-advanced-filters'
                        onClick={() => setShowAdvancedFilters(value => !value)}>
                        {showAdvancedFilters ? 'Fewer filters' : 'More filters'}
                        {advancedFilterCount > 0 && <span className='wf-filters-container__more-count'>{advancedFilterCount}</span>}
                        <i className={classNames('fa', showAdvancedFilters ? 'fa-angle-up' : 'fa-angle-down')} aria-hidden='true' />
                    </button>
                </div>
            </div>
            {activeFilterCount > 0 && (
                <div className='wf-filters-container__active' aria-label='Active filters'>
                    {props.nameValue && (
                        <button type='button' onClick={() => props.setNameValue('')} aria-label={`Remove name filter ${props.nameValue}`}>
                            Name or title: {props.nameValue} ×
                        </button>
                    )}
                    {props.labelContains && (
                        <button type='button' onClick={() => props.setLabelContains('')} aria-label={`Remove label contains filter ${props.labelContains}`}>
                            Label contains: {props.labelContains} ×
                        </button>
                    )}
                    {props.archiveFilter !== 'all' && (
                        <button type='button' onClick={() => props.setArchiveFilter('all')} aria-label='Remove archive filter'>
                            {ARCHIVE_FILTERS.find(item => item.id === props.archiveFilter)?.title} ×
                        </button>
                    )}
                    {props.labels.map(label => (
                        <button type='button' key={label} onClick={() => props.setLabels(props.labels.filter(item => item !== label))} aria-label={`Remove label filter ${label}`}>
                            {label} ×
                        </button>
                    ))}
                    {props.phases.map(phase => (
                        <button type='button' key={phase} onClick={() => props.setPhases(props.phases.filter(item => item !== phase))} aria-label={`Remove status filter ${phase}`}>
                            {phase} ×
                        </button>
                    ))}
                    {props.createdAfter && (
                        <button type='button' onClick={() => props.setCreatedAfter(undefined)} aria-label='Remove created since filter'>
                            Created since {props.createdAfter.toLocaleDateString()} ×
                        </button>
                    )}
                    {props.finishedBefore && (
                        <button type='button' onClick={() => props.setFinishedBefore(undefined)} aria-label='Remove finished before filter'>
                            Finished before {props.finishedBefore.toLocaleDateString()} ×
                        </button>
                    )}
                </div>
            )}
            <div className='wf-filters-container__grid wf-filters-container__grid--primary'>
                <div className='wf-filters-container__field'>
                    <label className='wf-filters-container__title' htmlFor='workflow-filter-namespace'>
                        Namespace
                    </label>
                    <NamespaceFilter
                        value={props.namespace}
                        id='workflow-filter-namespace'
                        ariaLabel='Run namespace'
                        onChange={props.setNamespace}
                        extraNamespaces={getUniqueNamespaces(props.workflows)}
                    />
                </div>
                <div className='wf-filters-container__field wf-filters-container__field--secondary'>
                    <label className='wf-filters-container__title' htmlFor='workflow-filter-archive'>
                        Archive state
                    </label>
                    <select
                        id='workflow-filter-archive'
                        className='argo-field'
                        value={props.archiveFilter}
                        onChange={event => props.setArchiveFilter(event.target.value as ArchiveFilter)}>
                        {ARCHIVE_FILTERS.map(item => (
                            <option key={item.id} value={item.id}>
                                {item.title}
                            </option>
                        ))}
                    </select>
                </div>
                <div className='wf-filters-container__field' data-testid='workflow-name-filter'>
                    <label className='wf-filters-container__title' htmlFor='workflow-filter-name'>
                        Search
                    </label>
                    <SearchModeFilter
                        id='workflow-filter-name'
                        mode={filterMode}
                        options={SEARCH_MODE_OPTIONS}
                        onModeChange={value => setFilterMode(value as typeof filterMode)}
                        modeAriaLabel='Run search filter'
                        value={filterMode === 'name' ? props.nameValue : filterMode === 'team' ? labelValue('team') : props.labelContains}
                        onValueChange={value => {
                            if (filterMode === 'name') props.setNameValue(value);
                            else if (filterMode === 'team') setLabel('team', value);
                            else props.setLabelContains(value);
                        }}
                        inputName={filterMode === 'name' ? 'wfNameFilter' : filterMode === 'team' ? 'runTeam' : 'runLabelContains'}
                        inputAriaLabel={filterMode === 'name' ? 'Run name or title contains' : filterMode === 'team' ? 'Filter runs by team label' : 'Run label contains'}
                        placeholder={filterMode === 'name' ? 'Type a name or title' : filterMode === 'team' ? 'Exact team label' : 'Type a label key or value'}
                        hint={filterMode === 'name' || filterMode === 'label' ? 'Searches across all pages; this may take time.' : undefined}
                    />
                </div>
            </div>
            {showAdvancedFilters && (
                <div id='workflow-advanced-filters' className='wf-filters-container__grid wf-filters-container__grid--advanced'>
                    <div className='wf-filters-container__field'>
                        <label className='wf-filters-container__title' htmlFor='workflow-filter-template'>
                            Job (namespace template)
                        </label>
                        <DataLoaderDropdown
                            id='workflow-filter-template'
                            ariaLabel='Job (namespace template)'
                            placeholder='All jobs'
                            value={labelValue(models.labels.workflowTemplate)}
                            loadKey={props.namespace}
                            load={async () => {
                                const list = await services.workflowTemplate.list(props.namespace, []);
                                return (list.items || []).map(x => x.metadata.name);
                            }}
                            onChange={setWorkflowTemplate}
                        />
                    </div>
                    <div className='wf-filters-container__field'>
                        <label className='wf-filters-container__title' htmlFor='workflow-filter-cron-workflow'>
                            Schedule
                        </label>
                        <DataLoaderDropdown
                            id='workflow-filter-cron-workflow'
                            ariaLabel='Schedule'
                            placeholder='All schedules'
                            value={labelValue(models.labels.cronWorkflow)}
                            loadKey={props.namespace}
                            load={async () => {
                                const list = await services.cronWorkflows.list(props.namespace);
                                return list.map(x => x.metadata.name);
                            }}
                            onChange={setCronWorkflow}
                        />
                    </div>
                    <div className='wf-filters-container__field wf-filters-container__field--phases'>
                        <h3 className='wf-filters-container__title'>Phases</h3>
                        <CheckboxFilter selected={props.phases} onChange={props.setPhases} items={phaseItems} type='phase' />
                    </div>
                    <div className='wf-filters-container__field wf-filters-container__field--dates'>
                        <div>
                            <label className='wf-filters-container__title' htmlFor='workflow-filter-created-after'>
                                Created since
                            </label>
                            <div className='wf-filters-container__content'>
                                <DatePicker
                                    id='workflow-filter-created-after'
                                    selected={props.createdAfter}
                                    onChange={props.setCreatedAfter}
                                    placeholderText='From'
                                    dateFormat='dd MMM yyyy'
                                    todayButton='Today'
                                    className='argo-field argo-textarea'
                                />
                                <button
                                    type='button'
                                    className='wf-filters-container__date-clear'
                                    aria-label='Clear created since date'
                                    onClick={() => props.setCreatedAfter(undefined)}>
                                    <i className='fa fa-times-circle' aria-hidden='true' />
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className='wf-filters-container__title' htmlFor='workflow-filter-finished-before'>
                                Finished before
                            </label>
                            <div className='wf-filters-container__content'>
                                <DatePicker
                                    id='workflow-filter-finished-before'
                                    selected={props.finishedBefore}
                                    onChange={props.setFinishedBefore}
                                    placeholderText='To'
                                    dateFormat='dd MMM yyyy'
                                    todayButton='Today'
                                    className='argo-field argo-textarea'
                                />
                                <button
                                    type='button'
                                    className='wf-filters-container__date-clear'
                                    aria-label='Clear finished before date'
                                    onClick={() => props.setFinishedBefore(undefined)}>
                                    <i className='fa fa-times-circle' aria-hidden='true' />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
