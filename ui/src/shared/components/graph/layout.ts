import {layoutGraphFast} from './fast-layout';
import {layoutGraphPretty} from './pretty-layout';
import {Graph, Node} from './types';

function edgeKey(edge: {v: string; w: string}) {
    return `${edge.v}\u0000${edge.w}`;
}

export function graphTopologySignature(graph: Graph) {
    const nodes = Array.from(graph.nodes.keys()).sort().join('\u0000');
    const edges = Array.from(graph.edges.keys())
        .map(edge => `${edge.v}\u0000${edge.w}`)
        .sort()
        .join('\u0000');
    const groups = Array.from(graph.nodeGroups.entries())
        .map(([group, nodes]) => `${group}:${Array.from(nodes).sort().join(',')}`)
        .sort()
        .join('\u0000');
    return `${nodes}\u0001${edges}\u0001${groups}`;
}

/** Copy calculated positions from a previous graph with the same topology. */
export function copyLayout(previous: Graph, current: Graph) {
    current.nodes.forEach((label, node) => {
        const previousLabel = previous.nodes.get(node);
        if (previousLabel) {
            label.x = previousLabel.x;
            label.y = previousLabel.y;
        }
    });

    const previousEdges = new Map(Array.from(previous.edges).map(([edge, label]) => [edgeKey(edge), label]));
    current.edges.forEach((label, edge) => {
        const previousLabel = previousEdges.get(edgeKey(edge));
        if (previousLabel) {
            label.points = previousLabel.points;
        }
    });
    current.width = previous.width;
    current.height = previous.height;
}

export function layout(graph: Graph, nodeSize: number, horizontal: boolean, hidden: (id: Node) => boolean, fast: boolean) {
    (fast ? layoutGraphFast : layoutGraphPretty)(graph, nodeSize, horizontal, hidden);
}
