import {render, screen} from '@testing-library/react';
import * as React from 'react';
import {MemoryRouter} from 'react-router-dom';

import {NodePhase, NodeStatus, Workflow} from '../../shared/models';
import {countNodesByPhase, NodeBoxScore, NowRunningNodes} from './node-box-score';

function node(id: string, phase: NodePhase, displayName = id): NodeStatus {
    return {id, displayName, name: id, phase} as NodeStatus;
}

describe('countNodesByPhase', () => {
    it('counts nodes by phase in display order and skips empty phases', () => {
        const counts = countNodesByPhase({
            a: node('a', 'Succeeded'),
            b: node('b', 'Succeeded'),
            c: node('c', 'Failed'),
            d: node('d', 'Running')
        });
        expect(counts).toEqual([
            {phase: 'Succeeded', count: 2},
            {phase: 'Running', count: 1},
            {phase: 'Failed', count: 1}
        ]);
    });

    it('returns nothing without nodes', () => {
        expect(countNodesByPhase(undefined)).toEqual([]);
        expect(countNodesByPhase({})).toEqual([]);
    });
});

describe('NodeBoxScore', () => {
    it('renders a tile per phase with the total step count', () => {
        const workflow = {status: {nodes: {a: node('a', 'Succeeded'), b: node('b', 'Succeeded'), c: node('c', 'Failed')}}} as unknown as Workflow;
        render(
            <MemoryRouter>
                <NodeBoxScore workflow={workflow} />
            </MemoryRouter>
        );
        expect(screen.getByText('Complete')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByRole('group', {name: 'Steps by status, 3 total'})).toBeInTheDocument();
    });

    it('renders nothing without nodes', () => {
        const workflow = {status: {}} as Workflow;
        const {container} = render(<NodeBoxScore workflow={workflow} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('NowRunningNodes', () => {
    it('renders nothing when no steps are running', () => {
        const workflow = {status: {nodes: {a: node('a', 'Succeeded')}}} as unknown as Workflow;
        const {container} = render(
            <MemoryRouter>
                <NowRunningNodes workflow={workflow} />
            </MemoryRouter>
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('links to the running step with its logs', () => {
        const workflow = {
            metadata: {namespace: 'argo', name: 'wf'},
            status: {nodes: {a: node('approve', 'Running')}}
        } as unknown as Workflow;
        render(
            <MemoryRouter>
                <NowRunningNodes workflow={workflow} />
            </MemoryRouter>
        );
        const link = screen.getByRole('link', {name: 'approve'});
        expect(link).toHaveAttribute('href', expect.stringContaining('nodeId='));
        expect(link).toHaveAttribute('href', expect.stringContaining('nodePanelView=logs'));
    });
});
