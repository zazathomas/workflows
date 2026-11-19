import {fireEvent, render, waitFor} from '@testing-library/react';
import {createMemoryHistory} from 'history';
import React from 'react';

import {App} from '../../../app';
import {exampleWorkflowTemplate} from '../../../shared/examples';
import {Workflow, WorkflowTemplate} from '../../../shared/models';
import requests from '../../../shared/services/requests';
import {WorkflowTemplateService} from '../../../shared/services/workflow-template-service';

jest.mock('../../../shared/services/workflow-template-service');
jest.mock('../../../shared/services/requests');

describe('WorkflowsList', () => {
    let workflowTemplate: WorkflowTemplate;

    beforeEach(() => {
        jest.clearAllMocks();
        workflowTemplate = exampleWorkflowTemplate('argo');
        // Mock out API calls
        jest.spyOn(WorkflowTemplateService, 'list').mockResolvedValue({items: [workflowTemplate]} as any);
        jest.spyOn(requests, 'get').mockResolvedValue({body: {}} as any);
        jest.spyOn(requests, 'post').mockReturnValue({send: jest.fn().mockResolvedValue('')} as any);
    });

    it('the approvals strip counts steps waiting on a human and links to the queue', async () => {
        // A running run with one suspended step: the strip counts it.
        const waiting: Workflow = {
            metadata: {name: 'waiting-run', namespace: 'argo', uid: 'uid-waiting', creationTimestamp: '2025-01-01T00:00:00Z'},
            spec: {entrypoint: 'main', templates: []},
            status: {
                phase: 'Running',
                startedAt: '2025-01-01T00:00:00Z',
                finishedAt: null,
                message: '',
                nodes: {
                    'wait-approval': {
                        id: 'wait-approval',
                        name: 'wait-approval',
                        displayName: 'wait-approval',
                        type: 'Suspend',
                        phase: 'Running',
                        boundaryID: 'waiting-run',
                        children: []
                    }
                },
                persistentVolumeClaims: [],
                compressedNodes: '',
                storedTemplates: {}
            }
        } as unknown as Workflow;
        jest.spyOn(requests, 'get').mockImplementation(((url: string) => {
            if (url.startsWith('api/v1/extensions/run-view') && url.includes('view=gate-count')) {
                return Promise.resolve({body: {count: 1}} as any);
            }
            if (url.startsWith('api/v1/workflows')) {
                return Promise.resolve({body: {metadata: {resourceVersion: '1'}, items: [waiting]}} as any);
            }
            return Promise.resolve({body: {}} as any);
        }) as any);

        const history = createMemoryHistory();
        history.push('/workflows/argo');

        const {findByText, queryByRole} = render(<App history={history} />);

        // The strip counts the suspended step and links to the namespace's queue.
        expect(await findByText('1 step is waiting for your approval')).toBeInTheDocument();
        const review = await findByText('Review');
        expect(review.closest('a')).toHaveAttribute('href', '/approvals/argo');

        // No Approvals entry in the navigation rail any more; the queue stays reachable.
        expect(queryByRole('button', {name: 'Approvals'})).not.toBeInTheDocument();
    });

    it('the approvals strip stays hidden without suspended steps', async () => {
        const free: Workflow = {
            metadata: {name: 'free-run', namespace: 'argo', uid: 'uid-free', creationTimestamp: '2025-01-01T00:00:00Z'},
            spec: {entrypoint: 'main', templates: []},
            status: {
                phase: 'Running',
                startedAt: '2025-01-01T00:00:00Z',
                finishedAt: null,
                message: '',
                nodes: {},
                persistentVolumeClaims: [],
                compressedNodes: '',
                storedTemplates: {}
            }
        } as unknown as Workflow;
        jest.spyOn(requests, 'get').mockImplementation(((url: string) => {
            if (url.startsWith('api/v1/workflows')) {
                return Promise.resolve({body: {metadata: {resourceVersion: '1'}, items: [free]}} as any);
            }
            return Promise.resolve({body: {}} as any);
        }) as any);

        const history = createMemoryHistory();
        history.push('/workflows?namespace=argo');

        const {queryByText} = render(<App history={history} />);

        // The run lists (its desktop row renders), but no approvals strip does.
        await waitFor(() => {
            expect(document.querySelectorAll('[aria-valuetext="free-run"]').length).toBeGreaterThan(0);
        });
        await waitFor(() => {
            expect(queryByText(/waiting for your approval/)).not.toBeInTheDocument();
        });
    });

    it('opens the run panel and updates the URL when clicked', async () => {
        const history = createMemoryHistory();
        history.push('/workflows?namespace=argo');

        const {getByRole} = render(<App history={history} />);
        expect(history.location.search).toBe('?namespace=argo&limit=50');

        // Click the run button and verify URL updates
        const submitWorkflowButton = getByRole('button', {name: 'Run job'});
        expect(submitWorkflowButton).toBeInTheDocument();
        fireEvent.click(submitWorkflowButton);
        await waitFor(() => {
            expect(history.location.search).toBe('?namespace=argo&sidePanel=submit-new-workflow&limit=50');
        });

        // Close through the panel's labelled button rather than a CSS class, so the
        // click always targets the live panel instead of a stale or unrelated node.
        fireEvent.click(getByRole('button', {name: 'Close run job panel'}));

        // Check sidePanel was removed from URL.
        await waitFor(() => {
            expect(history.location.search).toBe('?namespace=argo&limit=50');
        });
    });

    it('opens workflow creator with pre-filled URL parameters', async () => {
        const history = createMemoryHistory();
        history.push(`/workflows?sidePanel=submit-new-workflow&template=${workflowTemplate.metadata.name}&parameters[message]=test-hello`);

        const {findByRole, findByDisplayValue} = render(<App history={history} />);

        expect(await findByRole('heading', {name: 'Run job'})).toBeInTheDocument();
        expect(await findByRole('heading', {name: `argo/${workflowTemplate.metadata.name}`})).toBeInTheDocument();

        const parameterInput = await findByDisplayValue('test-hello');
        expect(parameterInput).toBeInTheDocument();
    });

    it('retains query parameters when side panel is closed', async () => {
        const history = createMemoryHistory();
        history.push('/workflows?namespace=argo&phase=Pending&label=test');

        const {getByRole} = render(<App history={history} />);
        expect(history.location.search).toBe('?namespace=argo&phase=Pending&label=test&limit=50');

        // Click the run button and verify URL updates
        const submitWorkflowButton = getByRole('button', {name: 'Run job'});
        expect(submitWorkflowButton).toBeInTheDocument();
        fireEvent.click(submitWorkflowButton);
        await waitFor(() => {
            expect(history.location.search).toBe('?namespace=argo&sidePanel=submit-new-workflow&phase=Pending&label=test&limit=50');
        });

        fireEvent.click(getByRole('button', {name: 'Close run job panel'}));

        // Check sidePanel was removed from URL but phase remains
        await waitFor(() => {
            expect(history.location.search).toBe('?namespace=argo&phase=Pending&label=test&limit=50');
        });
    });

    it('the Queued view shows only runs waiting on a synchronization lock', async () => {
        // Two running runs: one waits on a semaphore, one does not.
        const waiting: Workflow = {
            metadata: {name: 'waiting-run', namespace: 'argo', uid: 'uid-waiting', creationTimestamp: '2025-01-01T00:00:00Z'},
            spec: {entrypoint: 'main', templates: []},
            status: {
                phase: 'Running',
                startedAt: '2025-01-01T00:00:00Z',
                finishedAt: null,
                message: '',
                nodes: {},
                persistentVolumeClaims: [],
                compressedNodes: '',
                storedTemplates: {},
                synchronization: {semaphore: {waiting: {'waiting-run-1234': ['holder-run']}}}
            }
        };
        const free: Workflow = {
            metadata: {name: 'free-run', namespace: 'argo', uid: 'uid-free', creationTimestamp: '2025-01-01T00:00:00Z'},
            spec: {entrypoint: 'main', templates: []},
            status: {
                phase: 'Running',
                startedAt: '2025-01-01T00:00:00Z',
                finishedAt: null,
                message: '',
                nodes: {},
                persistentVolumeClaims: [],
                compressedNodes: '',
                storedTemplates: {}
            }
        };
        jest.spyOn(requests, 'get').mockImplementation(((url: string) => {
            if (url.startsWith('api/v1/workflows')) {
                return Promise.resolve({body: {metadata: {resourceVersion: '1'}, items: [waiting, free]}} as any);
            }
            return Promise.resolve({body: {}} as any);
        }) as any);

        const history = createMemoryHistory();
        history.push('/workflows?namespace=argo&synchronization=waiting');

        const {queryByText} = render(<App history={history} />);

        // The waiting run is listed (its desktop row renders); the free run is
        // filtered out. The mobile card also carries the name, so count rows.
        await waitFor(() => {
            expect(document.querySelectorAll('[aria-valuetext="waiting-run"]').length).toBeGreaterThan(0);
        });
        expect(queryByText('free-run')).not.toBeInTheDocument();

        // The queued-only toggle reflects the active filter.
        expect(history.location.search).toContain('synchronization=waiting');
    });

    it('the queued-only toggle filters the list', async () => {
        const waiting: Workflow = {
            metadata: {name: 'queued-run', namespace: 'argo', uid: 'uid-queued', creationTimestamp: '2025-01-01T00:00:00Z'},
            spec: {entrypoint: 'main', templates: []},
            status: {
                phase: 'Running',
                startedAt: '2025-01-01T00:00:00Z',
                finishedAt: null,
                message: '',
                nodes: {},
                persistentVolumeClaims: [],
                compressedNodes: '',
                storedTemplates: {},
                synchronization: {mutex: {waiting: {'queued-run-1234': ['holder']}}}
            }
        };
        jest.spyOn(requests, 'get').mockImplementation(((url: string) => {
            if (url.startsWith('api/v1/workflows')) {
                return Promise.resolve({body: {metadata: {resourceVersion: '1'}, items: [waiting]}} as any);
            }
            return Promise.resolve({body: {}} as any);
        }) as any);

        const history = createMemoryHistory();
        history.push('/workflows?namespace=argo');

        const {findByRole} = render(<App history={history} />);

        // Wait for the list to load, then click the live toggle.
        await waitFor(() => {
            expect(document.querySelectorAll('[aria-valuetext="queued-run"]').length).toBeGreaterThan(0);
        });
        const toggle = await findByRole('button', {name: /Queued only/i});
        fireEvent.click(toggle);

        await waitFor(() => {
            expect(history.location.search).toContain('synchronization=waiting');
        });
        // A run waiting on a mutex stays visible under the toggle (the row
        // renders in the table and in the details drawer).
        await waitFor(() => {
            expect(document.querySelectorAll('[data-workflow-name="queued-run"], [aria-valuetext="queued-run"]').length).toBeGreaterThan(0);
        });
    });
});
