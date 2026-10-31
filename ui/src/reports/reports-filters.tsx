import * as React from 'react';

import {DataLoaderDropdown} from '../shared/components/data-loader-dropdown';
import {NamespaceFilter} from '../shared/components/namespace-filter';
import {TagsInput} from '../shared/components/tags-input/tags-input';
import {NODE_PHASE} from '../shared/models';
import {services} from '../shared/services';

import './reports-filters.scss';

const labelKeyPhase = 'workflows.argoproj.io/phase';
const labelKeyWorkflowTemplate = 'workflows.argoproj.io/workflow-template';
const labelKeyCronWorkflow = 'workflows.argoproj.io/cron-workflow';

interface ReportFiltersProps {
    namespace: string;
    labels: string[];
    onChange: (newNamespace: string, newLabels: string[]) => void;
}

export function ReportFilters({namespace, labels, onChange}: ReportFiltersProps) {
    function getLabel(name: string) {
        const prefix = name + '=';
        return (labels.find(label => label.startsWith(prefix)) || '').slice(prefix.length);
    }

    function setLabel(name: string, value: string) {
        const otherLabels = labels.filter(label => !label.startsWith(name + '='));
        onChange(namespace, value ? [...otherLabels, name + '=' + value] : otherLabels);
    }

    function getPhase() {
        return getLabel(labelKeyPhase);
    }

    function setPhase(value: string) {
        setLabel(labelKeyPhase, value);
    }

    function setWorkflowTemplate(value: string) {
        setLabel(labelKeyWorkflowTemplate, value);
    }

    function setCronWorkflow(value: string) {
        setLabel(labelKeyCronWorkflow, value);
    }

    const activeFilterCount = labels.filter(label => label && !label.startsWith(labelKeyPhase)).length + (getPhase() ? 1 : 0);

    return (
        <section className='filter-bar' aria-labelledby='report-filters-heading'>
            <div className='filter-bar__header'>
                <div className='filter-bar__heading-group'>
                    <h2 id='report-filters-heading' className='filter-bar__heading'>
                        Filters
                    </h2>
                    {activeFilterCount > 0 && <span className='filter-bar__count'>{activeFilterCount} active</span>}
                </div>
                {activeFilterCount > 0 && (
                    <button type='button' className='filter-bar__clear' onClick={() => onChange(namespace, [])}>
                        Clear all
                    </button>
                )}
            </div>
            <div className='filter-bar__grid filter-bar__grid--two'>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='report-filter-namespace'>
                        Namespace
                    </label>
                    <NamespaceFilter id='report-filter-namespace' ariaLabel='Report namespace' value={namespace} onChange={newNamespace => onChange(newNamespace, labels)} />{' '}
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='report-filter-labels'>
                        Labels
                    </label>
                    <TagsInput id='report-filter-labels' ariaLabel='Report labels' placeholder='Add label' tags={labels} onChange={newLabels => onChange(namespace, newLabels)} />
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='report-filter-workflow-template'>
                        Job (namespace template)
                    </label>
                    <DataLoaderDropdown
                        id='report-filter-workflow-template'
                        ariaLabel='Report job (namespace template)'
                        placeholder='All jobs'
                        value={getLabel(labelKeyWorkflowTemplate)}
                        loadKey={namespace}
                        load={async () => {
                            const list = await services.workflowTemplate.list(namespace, []);
                            return (list.items || []).map(x => x.metadata.name);
                        }}
                        onChange={value => setWorkflowTemplate(value)}
                    />
                </div>
                <div className='filter-bar__field'>
                    <label className='filter-bar__title' htmlFor='report-filter-cron-workflow'>
                        Schedule
                    </label>
                    <DataLoaderDropdown
                        id='report-filter-cron-workflow'
                        ariaLabel='Report schedule'
                        placeholder='All schedules'
                        value={getLabel(labelKeyCronWorkflow)}
                        loadKey={namespace}
                        load={async () => {
                            const list = await services.cronWorkflows.list(namespace);
                            return list.map(x => x.metadata.name);
                        }}
                        onChange={value => setCronWorkflow(value)}
                    />
                </div>
                <div className='filter-bar__field'>
                    <h3 className='filter-bar__title'>Phase</h3>
                    <div className='filter-bar__options' role='radiogroup' aria-label='Report phase'>
                        {[
                            {value: '', label: 'All phases'},
                            {value: NODE_PHASE.SUCCEEDED, label: NODE_PHASE.SUCCEEDED},
                            {value: NODE_PHASE.ERROR, label: NODE_PHASE.ERROR},
                            {value: NODE_PHASE.FAILED, label: NODE_PHASE.FAILED}
                        ].map(phase => (
                            <label className='filter-bar__option' key={phase.value || 'all'}>
                                <input type='radio' name='report-phase' checked={phase.value === getPhase()} onChange={() => setPhase(phase.value)} />
                                {phase.label}
                            </label>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
