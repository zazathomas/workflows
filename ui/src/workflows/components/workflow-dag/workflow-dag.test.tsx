import {NodeStatus} from '../../../shared/models';
import {WorkflowDag} from './workflow-dag';

const workflowName = 'test-wf';

function node(id: string, phase: string, children: string[] = []): NodeStatus {
    return {id, name: id, type: 'Pod', phase, children} as NodeStatus;
}

describe('workflow dag hide-healthy filter', () => {
    const nodes: {[nodeId: string]: NodeStatus} = {
        'test-wf': node('test-wf', 'Running', ['step-a', 'step-b']),
        'step-a': node('step-a', 'Succeeded', ['step-c']),
        'step-b': node('step-b', 'Running'),
        'step-c': node('step-c', 'Succeeded'),
        'step-a-0': node('step-a-0', 'Succeeded')
    };

    it('renders every node by default', () => {
        const dag = new WorkflowDag({workflowName, nodes});
        dag.render();
        const graph = (dag as any).graph;
        expect(graph.nodes.has('step-a')).toBe(true);
        expect(graph.nodes.has('step-c')).toBe(true);
        expect(graph.nodes.size).toBeGreaterThanOrEqual(4);
    });

    it('hides succeeded nodes and keeps their children connected', () => {
        const dag = new WorkflowDag({workflowName, nodes});
        (dag as any).state = {...(dag as any).state, hideHealthyNodes: true};
        dag.render();
        const graph = (dag as any).graph;
        // step-a succeeded: hidden; its child step-c (also succeeded) is
        // hidden too. The root and the running step stay visible.
        expect(graph.nodes.has('step-a')).toBe(false);
        expect(graph.nodes.has('step-c')).toBe(false);
        expect(graph.nodes.has('test-wf')).toBe(true);
        expect(graph.nodes.has('step-b')).toBe(true);
        // No orphan edges reference the hidden nodes.
        for (const edge of graph.edges.keys()) {
            expect(edge.v).not.toBe('step-a');
            expect(edge.w).not.toBe('step-a');
        }
    });

    it('keeps the root visible even when everything succeeded', () => {
        const allHealthy: {[nodeId: string]: NodeStatus} = {
            'test-wf': node('test-wf', 'Succeeded', ['only-step']),
            'only-step': node('only-step', 'Succeeded')
        };
        const dag = new WorkflowDag({workflowName, nodes: allHealthy});
        (dag as any).state = {...(dag as any).state, hideHealthyNodes: true};
        dag.render();
        const graph = (dag as any).graph;
        expect(graph.nodes.has('test-wf')).toBe(true);
        expect(graph.nodes.has('only-step')).toBe(false);
    });
});
