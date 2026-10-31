import * as React from 'react';
import {useState} from 'react';

import {CheckboxFilter} from '../shared/components/checkbox-filter/checkbox-filter';
import {NamespaceFilter} from '../shared/components/namespace-filter';
import {SEARCH_MODE_OPTIONS, SearchModeFilter} from '../shared/components/search-mode-filter';
import * as models from '../shared/models';
import {getUniqueNamespaces} from '../shared/namespaces';

import './cron-workflow-filters.scss';

const ALL_STATES = ['Running', 'Suspended'];

interface WorkflowFilterProps {
    cronWorkflows: models.WorkflowTemplate[];
    namespace: string;
    labels: string[];
    states: string[];
    namePattern: string;
    onNamePatternChange: (value: string) => void;
    labelContains: string;
    onLabelContainsChange: (value: string) => void;
    onChange: (namespace: string, labels: string[], states: string[]) => void;
}

export function CronWorkflowFilters({
    cronWorkflows,
    namespace,
    labels,
    states,
    namePattern,
    onNamePatternChange,
    labelContains,
    onLabelContainsChange,
    onChange
}: WorkflowFilterProps) {
    const [filterMode, setFilterMode] = useState<'name' | 'team' | 'label'>(() => (labelContains && !namePattern ? 'label' : 'name'));
    const team = labels.find(label => label.startsWith('team='))?.slice('team='.length) || '';
    const activeFilterCount = [!!namePattern, !!labelContains, labels.length > 0, states.length !== ALL_STATES.length].filter(Boolean).length;

    return (
        <section className='filter-bar' aria-labelledby='cron-workflow-filters-heading'>
            <div className='filter-bar__header'>
                <div className='filter-bar__heading-group'>
                    <h2 id='cron-workflow-filters-heading' className='filter-bar__heading'>
                        Filters
                    </h2>
                    {activeFilterCount > 0 && <span className='filter-bar__count'>{activeFilterCount} active</span>}
                </div>
                {activeFilterCount > 0 && (
                    <button
                        type='button'
                        className='filter-bar__clear'
                        onClick={() => {
                            onNamePatternChange('');
                            onLabelContainsChange('');
                            onChange(namespace, [], ALL_STATES);
                        }}>
                        Clear all
                    </button>
                )}
            </div>
            <div className='filter-bar__grid filter-bar__grid--schedules'>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='cron-workflow-filter-namespace'>
                        Namespace
                    </label>
                    <NamespaceFilter
                        id='cron-workflow-filter-namespace'
                        ariaLabel='Cron workflow namespace'
                        value={namespace}
                        extraNamespaces={getUniqueNamespaces(cronWorkflows)}
                        onChange={value => onChange(value, labels, states)}
                    />
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='cron-workflow-filter-name'>
                        Search by
                    </label>
                    <SearchModeFilter
                        id='cron-workflow-filter-name'
                        mode={filterMode}
                        options={SEARCH_MODE_OPTIONS}
                        onModeChange={value => setFilterMode(value as typeof filterMode)}
                        modeAriaLabel='Schedule search filter'
                        value={filterMode === 'name' ? namePattern : filterMode === 'team' ? team : labelContains}
                        onValueChange={value => {
                            if (filterMode === 'name') onNamePatternChange(value);
                            else if (filterMode === 'team')
                                onChange(namespace, [...labels.filter(label => !label.startsWith('team=')), ...(value ? [`team=${value}`] : [])], states);
                            else onLabelContainsChange(value);
                        }}
                        inputName={filterMode === 'name' ? 'cronWorkflowName' : filterMode === 'team' ? 'cronWorkflowTeam' : 'cronWorkflowLabelContains'}
                        inputAriaLabel={
                            filterMode === 'name' ? 'Schedule name or title contains' : filterMode === 'team' ? 'Filter schedules by team label' : 'Schedule label contains'
                        }
                        placeholder={filterMode === 'name' ? 'Type a name or title' : filterMode === 'team' ? 'Exact team label' : 'Type a label key or value'}
                    />
                </div>
                <div className='filter-bar__field'>
                    <h3 className='filter-bar__title'>State</h3>
                    <CheckboxFilter
                        selected={states}
                        onChange={value => onChange(namespace, labels, value)}
                        items={[
                            {name: 'Running', count: 0},
                            {name: 'Suspended', count: 0}
                        ]}
                        type='state'
                    />
                </div>
            </div>
        </section>
    );
}
