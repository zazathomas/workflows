import {render, screen} from '@testing-library/react';
import * as React from 'react';

import {JobChanges} from './job-changes';

describe('JobChanges', () => {
    it('renders the summary and the change table', () => {
        render(
            <JobChanges
                object={
                    {
                        metadata: {
                            name: 'deploy',
                            generation: 4,
                            creationTimestamp: '2024-01-01T00:00:00Z',
                            managedFields: [
                                {manager: 'kubectl-edit', operation: 'Update', time: '2024-02-01T00:00:00Z', apiVersion: 'argoproj.io/v1alpha1'},
                                {manager: 'argo-server', operation: 'Apply', time: '2024-03-01T00:00:00Z', apiVersion: 'argoproj.io/v1alpha1', subresource: 'status'}
                            ]
                        }
                    } as any
                }
            />
        );

        expect(screen.getByRole('group', {name: 'Object change summary'})).toBeInTheDocument();
        expect(screen.getAllByText('argo-server')).toHaveLength(2);
        expect(screen.getByText('kubectl-edit')).toBeInTheDocument();
        expect(screen.getByText('Applied')).toBeInTheDocument();
        expect(screen.getByText('Updated')).toBeInTheDocument();
        expect(screen.getByText('status')).toBeInTheDocument();
        expect(screen.getByRole('table', {name: 'Object change history'})).toBeInTheDocument();
        expect(screen.getByText('4')).toBeInTheDocument();
    });

    it('explains when the server strips managed fields', () => {
        render(<JobChanges object={{metadata: {name: 'deploy'}} as any} />);
        expect(screen.getByText('No change history')).toBeInTheDocument();
        expect(screen.getByText(/does not report changes to "deploy"/)).toBeInTheDocument();
    });
});
