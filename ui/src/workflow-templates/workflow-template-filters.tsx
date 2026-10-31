import * as React from 'react';
import {useState} from 'react';

import {NamespaceFilter} from '../shared/components/namespace-filter';
import {SEARCH_MODE_OPTIONS, SearchModeFilter} from '../shared/components/search-mode-filter';
import * as models from '../shared/models';
import {getUniqueNamespaces} from '../shared/namespaces';

import './workflow-template-filters.scss';

export type JobTypeFilter = 'both' | 'workflow' | 'cluster';

interface WorkflowFilterProps {
    templates: models.WorkflowTemplate[];
    namespace: string;
    namePattern: string;
    labelContains: string;
    onLabelContainsChange: (value: string) => void;
    labels: string[];
    jobType: JobTypeFilter;
    onJobTypeChange: (type: JobTypeFilter) => void;
    onChange: (namespace: string, namePattern: string, labels: string[]) => void;
}

export function WorkflowTemplateFilters({
    templates,
    namespace,
    namePattern,
    labelContains,
    onLabelContainsChange,
    labels,
    jobType,
    onJobTypeChange,
    onChange
}: WorkflowFilterProps) {
    const [filterMode, setFilterMode] = useState<'name' | 'team' | 'label'>(() => (labelContains && !namePattern ? 'label' : 'name'));
    const team = labels.find(label => label.startsWith('team='))?.slice('team='.length) || '';
    const activeFilterCount = [namePattern, labelContains, labels.length > 0, jobType !== 'both'].filter(Boolean).length;

    return (
        <section className='filter-bar' aria-labelledby='workflow-template-filters-heading'>
            <div className='filter-bar__header'>
                <div className='filter-bar__heading-group'>
                    <h2 id='workflow-template-filters-heading' className='filter-bar__heading'>
                        Filters
                    </h2>
                    {activeFilterCount > 0 && <span className='filter-bar__count'>{activeFilterCount} active</span>}
                </div>
                {activeFilterCount > 0 && (
                    <button
                        type='button'
                        className='filter-bar__clear'
                        onClick={() => {
                            onChange(namespace, '', []);
                            onLabelContainsChange('');
                            onJobTypeChange('both');
                        }}>
                        Clear all
                    </button>
                )}
            </div>
            {activeFilterCount > 0 && (
                <div className='filter-bar__active' aria-label='Active filters'>
                    {namePattern && (
                        <button type='button' onClick={() => onChange(namespace, '', labels)}>
                            Name or title: {namePattern} ×
                        </button>
                    )}
                    {labelContains && (
                        <button type='button' onClick={() => onLabelContainsChange('')}>
                            Label contains: {labelContains} ×
                        </button>
                    )}
                    {labels.map(label => (
                        <button
                            type='button'
                            key={label}
                            onClick={() =>
                                onChange(
                                    namespace,
                                    namePattern,
                                    labels.filter(item => item !== label)
                                )
                            }>
                            {label} ×
                        </button>
                    ))}
                </div>
            )}
            <div className='filter-bar__grid'>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='workflow-template-filter-type'>
                        Type
                    </label>
                    <select id='workflow-template-filter-type' className='argo-field' value={jobType} onChange={event => onJobTypeChange(event.target.value as JobTypeFilter)}>
                        <option value='both'>Both template types</option>
                        <option value='workflow'>Workflow templates</option>
                        <option value='cluster'>Cluster workflow templates</option>
                    </select>
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='workflow-template-filter-namespace'>
                        Namespace
                    </label>
                    <NamespaceFilter
                        id='workflow-template-filter-namespace'
                        ariaLabel='Workflow template namespace'
                        value={namespace}
                        onChange={value => onChange(value, namePattern, labels)}
                        extraNamespaces={getUniqueNamespaces(templates)}
                    />
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='workflow-template-filter-mode'>
                        Search by
                    </label>
                    <SearchModeFilter
                        id='workflow-template-filter-input'
                        mode={filterMode}
                        options={SEARCH_MODE_OPTIONS}
                        onModeChange={value => setFilterMode(value as typeof filterMode)}
                        modeAriaLabel='Job search filter'
                        value={filterMode === 'name' ? namePattern : filterMode === 'team' ? team : labelContains}
                        onValueChange={value => {
                            if (filterMode === 'name') onChange(namespace, value, labels);
                            else if (filterMode === 'team')
                                onChange(namespace, namePattern, [...labels.filter(label => !label.startsWith('team=')), ...(value ? [`team=${value}`] : [])]);
                            else onLabelContainsChange(value);
                        }}
                        inputName={filterMode === 'name' ? 'wfnamePattern' : filterMode === 'team' ? 'team' : 'jobLabelContains'}
                        inputAriaLabel={filterMode === 'name' ? 'Job name or title contains' : filterMode === 'team' ? 'Filter jobs by team label' : 'Job label contains'}
                        placeholder={filterMode === 'name' ? 'Type a name or title' : filterMode === 'team' ? 'Exact team label' : 'Type a label key or value'}
                        hint={filterMode === 'name' || filterMode === 'label' ? 'Searches across all pages; this may take time.' : undefined}
                    />
                </div>
            </div>
        </section>
    );
}
