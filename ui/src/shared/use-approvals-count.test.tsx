import {render} from '@testing-library/react';
import * as React from 'react';

import {countSuspendedNodes} from './approvals';
import {NodeStatus, Workflow} from './models';
import {services} from './services';
import {useApprovalsCount} from './use-approvals-count';

function suspendNode(id: string): NodeStatus {
    return {id, name: id, type: 'Suspend', phase: 'Running'} as NodeStatus;
}

function workflow(name: string, nodes: NodeStatus[]): Workflow {
    return {
        metadata: {name, namespace: 'argo', uid: `uid-${name}`},
        status: {phase: 'Running', startedAt: '2024-01-01T00:00:00Z', nodes: Object.fromEntries(nodes.map(node => [node.id, node]))}
    } as unknown as Workflow;
}

describe('countSuspendedNodes', () => {
    it('counts suspended steps across runs', () => {
        const wfs = [workflow('one', [suspendNode('a'), suspendNode('b')]), workflow('two', [{id: 'c', type: 'Pod', phase: 'Running'} as NodeStatus])];
        expect(countSuspendedNodes(wfs)).toBe(2);
        expect(countSuspendedNodes([])).toBe(0);
    });
});

describe('useApprovalsCount', () => {
    function Probe({namespace}: {namespace: string}) {
        const count = useApprovalsCount(namespace);
        return <span data-testid='count'>{count === undefined ? 'none' : count}</span>;
    }

    it('polls the number of suspended steps', async () => {
        const list = jest.spyOn(services.workflows, 'approvalCount').mockResolvedValue(3);

        const {findByTestId} = render(<Probe namespace='argo' />);

        expect(await findByTestId('count')).toHaveTextContent('3');
        expect(list).toHaveBeenCalledWith('argo');
    });

    it('clears the badge when listing fails (for example without permission)', async () => {
        jest.spyOn(services.workflows, 'approvalCount').mockRejectedValue(new Error('forbidden'));
        const {findByTestId} = render(<Probe namespace='argo' />);
        expect(await findByTestId('count')).toHaveTextContent('none');
    });

    it('shares one poll across consumers in the same namespace', async () => {
        // The nav item's attention dot and the Runs page's approvals strip both
        // subscribe; only one listing request serves them.
        const list = jest.spyOn(services.workflows, 'approvalCount').mockResolvedValue(1);
        // jest reuses the spy the earlier tests installed; count only this
        // test's calls.
        list.mockClear();

        const {findAllByTestId} = render(
            <>
                <Probe namespace='argo' />
                <Probe namespace='argo' />
            </>
        );

        expect(await findAllByTestId('count')).toHaveLength(2);
        for (const probe of await findAllByTestId('count')) {
            expect(probe).toHaveTextContent('1');
        }
        expect(list).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh poll when the last consumer leaves and one returns', async () => {
        const list = jest.spyOn(services.workflows, 'approvalCount').mockResolvedValue(2);

        const first = render(<Probe namespace='argo' />);
        expect(await first.findByTestId('count')).toHaveTextContent('2');
        first.unmount();

        // The store is gone with its last listener; the next consumer polls
        // afresh rather than receiving the stale count.
        list.mockClear();
        const second = render(<Probe namespace='argo' />);
        expect(await second.findByTestId('count')).toHaveTextContent('2');
        expect(list).toHaveBeenCalledTimes(1);
    });
});
