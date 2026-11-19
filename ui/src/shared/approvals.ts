import {NodeStatus, Workflow} from './models';

// The list API prunes fields; these are what the approvals queue needs.
export const APPROVALS_LIST_FIELDS = [
    'metadata',
    'items.metadata.uid',
    'items.metadata.name',
    'items.metadata.namespace',
    'items.metadata.creationTimestamp',
    'items.metadata.labels',
    'items.metadata.annotations',
    'items.status.phase',
    'items.status.startedAt',
    'items.status.nodes'
];

/** Steps of a run that are suspended, waiting on a human. */
export function findSuspendedNodes(workflow: Workflow): NodeStatus[] {
    return Object.values(workflow.status?.nodes || {}).filter(node => node.type === 'Suspend' && node.phase === 'Running');
}

export interface ApprovalItem {
    workflow: Workflow;
    node: NodeStatus;
}

export function toApprovalItems(workflows: Workflow[]): ApprovalItem[] {
    const items: ApprovalItem[] = [];
    (workflows || []).forEach(workflow => findSuspendedNodes(workflow).forEach(node => items.push({workflow, node})));
    return items;
}

/** The number of suspended steps across the given runs (the nav badge). */
export function countSuspendedNodes(workflows: Workflow[]): number {
    return (workflows || []).reduce((count, workflow) => count + findSuspendedNodes(workflow).length, 0);
}
