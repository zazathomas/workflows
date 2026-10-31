import {Workflow} from '../../../shared/models';

export const OPTIONAL_COLUMNS = ['namespace', 'started', 'finished', 'duration', 'progress', 'message', 'details', 'archived'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export type SortColumn = 'name' | 'status' | 'started' | 'finished';
export type SortDirection = 'ascending' | 'descending';

export function sortWorkflows(workflows: Workflow[], column: SortColumn, direction: SortDirection): Workflow[] {
    const value = (wf: Workflow): string => {
        switch (column) {
            case 'name':
                return wf.metadata.name || '';
            case 'status':
                return wf.status?.phase || '';
            case 'started':
                return wf.status?.startedAt || '';
            case 'finished':
                return wf.status?.finishedAt || '';
        }
    };
    return [...workflows].sort((a, b) => {
        const left = value(a);
        const right = value(b);
        if (column === 'started' || column === 'finished') {
            const leftTime = Date.parse(left);
            const rightTime = Date.parse(right);
            if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : Number.isFinite(rightTime) ? 1 : 0;
            return (leftTime - rightTime) * (direction === 'ascending' ? 1 : -1);
        }
        if (!left || !right) return left ? -1 : right ? 1 : 0;
        return left.localeCompare(right, undefined, {numeric: true, sensitivity: 'base'}) * (direction === 'ascending' ? 1 : -1);
    });
}
