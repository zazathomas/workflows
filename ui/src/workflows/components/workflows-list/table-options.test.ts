import {Workflow} from '../../../shared/models';
import {sortWorkflows} from './table-options';

const make = (name: string, startedAt: string, phase = 'Running') => ({metadata: {name}, status: {startedAt, phase}}) as Workflow;

describe('sortWorkflows', () => {
    it('sorts names without mutating the input', () => {
        const workflows = [make('job-10', ''), make('job-2', '')];
        expect(sortWorkflows(workflows, 'name', 'ascending').map(w => w.metadata.name)).toEqual(['job-2', 'job-10']);
        expect(workflows[0].metadata.name).toBe('job-10');
    });

    it('sorts timestamps by instant and keeps missing values last', () => {
        const workflows = [make('missing', ''), make('later', '2025-01-01T02:00:00+01:00'), make('earlier', '2025-01-01T00:30:00Z')];
        expect(sortWorkflows(workflows, 'started', 'ascending').map(w => w.metadata.name)).toEqual(['earlier', 'later', 'missing']);
        expect(sortWorkflows(workflows, 'started', 'descending').map(w => w.metadata.name)).toEqual(['later', 'earlier', 'missing']);
    });
});
