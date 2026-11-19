import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import * as React from 'react';
import {MemoryRouter} from 'react-router-dom';

import {Context} from '../shared/context';
import {NodeStatus, Workflow} from '../shared/models';
import {services} from '../shared/services';
import {Approvals, findSuspendedNodes, toApprovalItems} from './approvals';

function suspendNode(id: string): NodeStatus {
    return {id, displayName: `step-${id}`, name: `step-${id}`, type: 'Suspend', phase: 'Running', startedAt: '2024-01-01T00:00:00Z'} as NodeStatus;
}

function podNode(id: string): NodeStatus {
    return {id, displayName: `pod-${id}`, name: `pod-${id}`, type: 'Pod', phase: 'Succeeded'} as NodeStatus;
}

function workflow(name: string, nodes: NodeStatus[]): Workflow {
    return {
        metadata: {name, namespace: 'argo', uid: `uid-${name}`, labels: {'workflows.argoproj.io/workflow-template': 'deploy'}},
        status: {phase: 'Running', startedAt: '2024-01-01T00:00:00Z', nodes: Object.fromEntries(nodes.map(node => [node.id, node]))}
    } as unknown as Workflow;
}

describe('findSuspendedNodes', () => {
    it('finds running suspend nodes only', () => {
        const wf = workflow('wf', [suspendNode('a'), podNode('b'), {id: 'c', type: 'Suspend', phase: 'Succeeded'} as NodeStatus]);
        const found = findSuspendedNodes(wf);
        expect(found).toHaveLength(1);
        expect(found[0].id).toBe('a');
    });
});

describe('toApprovalItems', () => {
    it('pairs each suspended node with its run', () => {
        const items = toApprovalItems([workflow('one', [suspendNode('a')]), workflow('two', [podNode('b')])]);
        expect(items).toHaveLength(1);
        expect(items[0].workflow.metadata.name).toBe('one');
        expect(items[0].node.id).toBe('a');
    });
});

describe('Approvals', () => {
    const context = {navigation: {goto: jest.fn()}, popup: {confirm: jest.fn().mockResolvedValue(true)}, notifications: {}, history: {}} as any;

    function renderPage() {
        return render(
            <Context.Provider value={context}>
                <MemoryRouter>
                    <Approvals
                        match={{params: {}, isExact: true, path: '/approvals', url: '/approvals'}}
                        location={{pathname: '/approvals', search: '', hash: '', state: undefined}}
                        history={{} as any}
                    />
                </MemoryRouter>
            </Context.Provider>
        );
    }

    it('approves a suspended step by recording a decision', async () => {
        const list = jest.spyOn(services.workflows, 'runView').mockResolvedValue({items: [workflow('wf', [suspendNode('a')])]} as any);
        const decide = jest.spyOn(services.approvals, 'decide').mockResolvedValue({} as any);
        renderPage();
        const approveButton = await screen.findByRole('button', {name: 'Approve step-a on wf'});
        fireEvent.click(approveButton);
        await waitFor(() => expect(decide).toHaveBeenCalledWith('argo', 'wf', 'a', {decision: 'approve', workflowUID: 'uid-wf', startedAt: '2024-01-01T00:00:00Z'}));
        list.mockRestore();
        decide.mockRestore();
    });

    it('rejects a suspended step by failing that node only', async () => {
        const list = jest.spyOn(services.workflows, 'runView').mockResolvedValue({items: [workflow('wf', [suspendNode('a')])]} as any);
        const decide = jest.spyOn(services.approvals, 'decide').mockResolvedValue({} as any);
        renderPage();
        const rejectButton = await screen.findByRole('button', {name: 'Reject step-a on wf'});
        fireEvent.click(rejectButton);
        await waitFor(() => expect(decide).toHaveBeenCalledWith('argo', 'wf', 'a', {decision: 'reject', workflowUID: 'uid-wf', startedAt: '2024-01-01T00:00:00Z'}));
        list.mockRestore();
        decide.mockRestore();
    });

    it('shows the empty state when nothing is waiting', async () => {
        const list = jest.spyOn(services.workflows, 'runView').mockResolvedValue({items: []} as any);
        renderPage();
        expect(await screen.findByText('No pending approvals')).toBeInTheDocument();
        list.mockRestore();
    });
});
