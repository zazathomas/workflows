import {ANNOTATION_TITLE} from './annotations';
import {Pagination} from './pagination';

interface NamedResource {
    metadata: {name?: string; annotations?: {[key: string]: string}; labels?: {[key: string]: string}};
}

export function matchesNameOrTitle(resource: NamedResource, query: string): boolean {
    const term = query.trim().toLocaleLowerCase();
    return !term || [resource.metadata.name, resource.metadata.annotations?.[ANNOTATION_TITLE]].some(value => value?.toLocaleLowerCase().includes(term));
}

export function matchesLabelContains(resource: NamedResource, query: string): boolean {
    const term = query.trim().toLocaleLowerCase();
    return !term || Object.entries(resource.metadata.labels || {}).some(([key, value]) => `${key}=${value}`.toLocaleLowerCase().includes(term));
}

export function matchesWorkflowName(resource: NamedResource, query: string, mode: 'Contains' | 'Prefix' | 'Exact' | 'NotEquals'): boolean {
    if (!query) return true;
    const name = resource.metadata.name || '';
    switch (mode) {
        case 'Contains':
            return matchesNameOrTitle(resource, query);
        case 'Prefix':
            return name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase());
        case 'Exact':
            return name === query;
        case 'NotEquals':
            return name !== query;
    }
}

interface Page<T> {
    items?: T[];
    metadata?: {continue?: string; resourceVersion?: string};
}

// Fetch every server page so title matches are not restricted to the loaded page.
export async function fetchAllPages<T>(load: (pagination: Pagination) => Promise<Page<T>>): Promise<{items: T[]; metadata: NonNullable<Page<T>['metadata']>}> {
    const items: T[] = [];
    const offsets = new Set<string>();
    let offset: string;
    let metadata: Page<T>['metadata'];
    do {
        const page = await load({limit: 200, offset});
        if (!metadata) metadata = page.metadata;
        items.push(...(page.items || []));
        offset = page.metadata?.continue;
        if (offset && offsets.has(offset)) throw new Error('The server returned a repeated pagination token.');
        if (offset) offsets.add(offset);
    } while (offset);
    return {items, metadata: {...metadata, continue: undefined}};
}

export function searchPageOffset(value?: string): number {
    const match = /^search:(\d+)$/.exec(value || '');
    return match ? Number(match[1]) : 0;
}
