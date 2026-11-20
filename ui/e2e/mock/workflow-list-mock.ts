import type {ObjectMeta} from 'argo-ui/src/models/kubernetes';

export interface MockWorkflow {
    metadata: ObjectMeta;
}

// Model the server's substring filtering before pagination. Other list filters
// are supplied by the individual tests that exercise them.
export function workflowListResponse(items: MockWorkflow[], params: URLSearchParams) {
    const selectors = new Map(
        (params.get('listOptions.fieldSelector') || '')
            .split(',')
            .filter(Boolean)
            .map(selector => {
                const separator = selector.indexOf('=');
                return [selector.slice(0, separator), selector.slice(separator + 1)];
            })
    );
    const searchTerm = (field: string) =>
        Buffer.from(selectors.get(field) || '', 'hex')
            .toString('utf8')
            .trim()
            .toLowerCase();
    const nameTerm = searchTerm('ext.nameTitleContains');
    const labelTerm = searchTerm('ext.labelContains');
    const matching = items.filter(item => {
        const {name, annotations, labels} = item.metadata;
        return (
            (!nameTerm || [name, annotations?.['workflows.argoproj.io/title']].some(value => value?.toLowerCase().includes(nameTerm))) &&
            (!labelTerm || Object.entries(labels || {}).some(([key, value]) => `${key}=${value}`.toLowerCase().includes(labelTerm)))
        );
    });
    const offset = Number(params.get('listOptions.continue') || 0);
    const limit = Number(params.get('listOptions.limit') || 0);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) throw new Error('Invalid mock workflow pagination');
    const end = limit ? offset + limit : undefined;
    return {
        metadata: {resourceVersion: '1', ...(end !== undefined && end < matching.length ? {continue: String(end)} : {})},
        items: matching.slice(offset, end)
    };
}
