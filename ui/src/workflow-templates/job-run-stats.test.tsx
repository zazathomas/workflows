import {render, screen} from '@testing-library/react';
import * as React from 'react';

import {Workflow} from '../shared/models';
import {computeJobStats, JobRunStats} from './job-run-stats';

function run(name: string, phase: string, startedAt?: string, finishedAt?: string): Workflow {
    return {metadata: {name, uid: name}, status: {phase, startedAt, finishedAt}} as unknown as Workflow;
}

describe('computeJobStats', () => {
    it('computes totals, success rate and average duration from finished runs', () => {
        const stats = computeJobStats([
            run('a', 'Succeeded', '2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z'),
            run('b', 'Succeeded', '2024-01-02T00:00:00Z', '2024-01-02T00:03:00Z'),
            run('c', 'Failed', '2024-01-03T00:00:00Z', '2024-01-03T00:00:30Z'),
            run('d', 'Running', '2024-01-04T00:00:00Z')
        ]);
        expect(stats.total).toBe(4);
        expect(stats.successRate).toBe(67);
        expect(stats.averageDuration).toBe((60 + 180 + 30) / 3);
        expect(stats.lastStatus).toBe('Running');
    });

    it('reports the last run by start time', () => {
        const stats = computeJobStats([run('older', 'Succeeded', '2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z'), run('newer', 'Failed', '2024-02-01T00:00:00Z')]);
        expect(stats.lastStatus).toBe('Failed');
    });

    it('returns undefined rates without finished runs', () => {
        const stats = computeJobStats([run('a', 'Running', '2024-01-01T00:00:00Z')]);
        expect(stats.successRate).toBeUndefined();
        expect(stats.averageDuration).toBeUndefined();
    });
});

describe('JobRunStats', () => {
    it('renders the stat tiles', () => {
        render(<JobRunStats workflows={[run('a', 'Succeeded', '2024-01-01T00:00:00Z', '2024-01-01T00:01:00Z')]} />);
        expect(screen.getByRole('group', {name: 'Job statistics from recent runs'})).toBeInTheDocument();
        expect(screen.getByText('Runs')).toBeInTheDocument();
        expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('renders nothing without runs', () => {
        const {container} = render(<JobRunStats workflows={[]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
