import {fireEvent, render} from '@testing-library/react';
import * as React from 'react';

import * as models from '../../../shared/models';
import {matchesArchiveFilter, matchesWorkflowDates, WorkflowFilters} from './workflow-filters';

jest.mock('../../../shared/components/data-loader-dropdown', () => ({
    DataLoaderDropdown: (props: {id: string; ariaLabel: string; placeholder: string; value: string; onChange: (value: string) => void}) =>
        React.createElement(
            'select',
            {'id': props.id, 'aria-label': props.ariaLabel, 'value': props.value, 'onChange': (event: React.ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)},
            React.createElement('option', {value: ''}, props.placeholder),
            React.createElement('option', {value: 'example'}, 'example')
        )
}));

function workflow(archived: boolean): models.Workflow {
    return {
        metadata: {
            name: archived ? 'archived' : 'live',
            labels: archived ? {[models.archivalStatus]: 'Persisted'} : {}
        }
    } as models.Workflow;
}

describe('matchesArchiveFilter', () => {
    it('matches all, live, and archived workflows', () => {
        const live = workflow(false);
        const archived = workflow(true);

        expect(matchesArchiveFilter(live, 'all')).toBe(true);
        expect(matchesArchiveFilter(archived, 'all')).toBe(true);
        expect(matchesArchiveFilter(live, 'live')).toBe(true);
        expect(matchesArchiveFilter(archived, 'live')).toBe(false);
        expect(matchesArchiveFilter(live, 'archived')).toBe(false);
        expect(matchesArchiveFilter(archived, 'archived')).toBe(true);
    });
});

describe('matchesWorkflowDates', () => {
    it('keeps watched updates within the selected creation and completion bounds', () => {
        const item = {metadata: {creationTimestamp: '2025-01-02T00:00:00Z'}, status: {finishedAt: '2025-01-03T00:00:00Z'}} as models.Workflow;
        expect(matchesWorkflowDates(item, new Date('2025-01-02T00:00:00Z'), new Date('2025-01-03T00:00:00Z'))).toBe(true);
        expect(matchesWorkflowDates(item, new Date('2025-01-04T00:00:00Z'))).toBe(false);
        expect(matchesWorkflowDates(item, undefined, new Date('2025-01-02T00:00:00Z'))).toBe(false);
        expect(matchesWorkflowDates({...item, status: {} as models.Workflow['status']}, undefined, new Date())).toBe(false);
    });
});

describe('WorkflowFilters', () => {
    const props = {
        workflows: [] as models.Workflow[],
        namespace: 'argo',
        phaseItems: ['Pending', 'Running', 'Succeeded', 'Failed', 'Error'] as models.WorkflowPhase[],
        phases: [] as models.WorkflowPhase[],
        labels: [] as string[],
        archiveFilter: 'all' as const,
        setArchiveFilter: jest.fn(),
        setNamespace: jest.fn(),
        setPhases: jest.fn(),
        setLabels: jest.fn(),
        setCreatedAfter: jest.fn(),
        setFinishedBefore: jest.fn(),
        nameFilter: 'Contains' as const,
        nameValue: '',
        labelContains: '',
        setLabelContains: jest.fn(),
        setNameFilter: jest.fn(),
        setNameValue: jest.fn(),
        clearFilters: jest.fn()
    };

    it('keeps advanced filters collapsed until requested', () => {
        const {getByRole, queryByLabelText} = render(React.createElement(WorkflowFilters, props));

        const moreFilters = getByRole('button', {name: 'More filters'});
        expect(moreFilters).toHaveAttribute('aria-expanded', 'false');
        expect(queryByLabelText('Job (namespace template)')).not.toBeInTheDocument();

        fireEvent.click(moreFilters);

        expect(getByRole('button', {name: 'Fewer filters'})).toHaveAttribute('aria-expanded', 'true');
        expect(queryByLabelText('Job (namespace template)')).toBeInTheDocument();
    });

    it('preserves unrelated labels and clears the selected job filter', () => {
        const setLabels = jest.fn();
        const {getByRole, getByLabelText, rerender} = render(React.createElement(WorkflowFilters, {...props, labels: ['team=platform'], setLabels}));
        fireEvent.click(getByRole('button', {name: /More filters/}));
        const select = getByLabelText('Job (namespace template)') as HTMLSelectElement;
        expect(select.value).toBe('');
        fireEvent.change(select, {target: {value: 'example'}});
        expect(setLabels).toHaveBeenLastCalledWith(['team=platform', `${models.labels.workflowTemplate}=example`]);
        rerender(React.createElement(WorkflowFilters, {...props, labels: ['team=platform', `${models.labels.workflowTemplate}=example`], setLabels}));
        expect(select.value).toBe('example');
        fireEvent.change(select, {target: {value: ''}});
        expect(setLabels).toHaveBeenLastCalledWith(['team=platform']);
    });

    it('allows individual active filters to be removed', () => {
        const setPhases = jest.fn();
        const setLabels = jest.fn();
        const {getByRole} = render(React.createElement(WorkflowFilters, {...props, phases: ['Running'], labels: ['team=platform'], setPhases, setLabels}));
        fireEvent.click(getByRole('button', {name: 'Remove status filter Running'}));
        expect(setPhases).toHaveBeenCalledWith([]);
        fireEvent.click(getByRole('button', {name: 'Remove label filter team=platform'}));
        expect(setLabels).toHaveBeenCalledWith([]);
    });

    it('shows active advanced filters on initial render', () => {
        const {getByRole} = render(React.createElement(WorkflowFilters, {...props, phases: ['Running']}));

        expect(getByRole('button', {name: /Fewer filters/})).toHaveAttribute('aria-expanded', 'true');
    });
});
