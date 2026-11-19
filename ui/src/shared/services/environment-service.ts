import requests from './requests';

export interface EnvironmentKey {
    name: string;
    /** Byte length of the value; the value itself never leaves the server. */
    size: number;
}

export interface EnvironmentResource {
    kind: 'ConfigMap' | 'Secret';
    name: string;
    keys?: EnvironmentKey[];
    type?: string;
    immutable?: boolean;
    createdAt?: string;
}

export interface EnvironmentListing {
    namespace: string;
    configMaps: EnvironmentResource[];
    secrets: EnvironmentResource[];
    errors?: string[];
    configMapsTruncated?: boolean;
    secretsTruncated?: boolean;
    configMapCursor?: string;
    secretCursor?: string;
}

interface EnvironmentPage {
    items: EnvironmentResource[];
    continue?: string;
}

function metadataURL(namespace: string, kind: EnvironmentResource['kind'], extra: Record<string, string> = {}) {
    return `api/v1/extensions/environment?${new URLSearchParams({namespace, view: 'metadata', kind, ...extra})}`;
}

export const EnvironmentService = {
    list(namespace: string): Promise<EnvironmentListing> {
        if (!namespace) {
            return Promise.reject(new Error('namespace is required'));
        }
        return requests.get(`api/v1/extensions/environment?${new URLSearchParams({namespace})}`).then(res => res.body as EnvironmentListing);
    },

    page(namespace: string, kind: EnvironmentResource['kind'], cursor?: string): Promise<EnvironmentPage> {
        return requests.get(metadataURL(namespace, kind, cursor ? {continue: cursor} : {})).then(res => res.body as EnvironmentPage);
    },

    details(namespace: string, kind: EnvironmentResource['kind'], name: string): Promise<EnvironmentResource> {
        return requests.get(metadataURL(namespace, kind, {name})).then(res => res.body as EnvironmentResource);
    },

    async metadata(namespace: string): Promise<EnvironmentListing> {
        const [configMaps, secrets] = await Promise.allSettled([this.page(namespace, 'ConfigMap'), this.page(namespace, 'Secret')]);
        if (configMaps.status === 'rejected' && secrets.status === 'rejected') throw configMaps.reason;
        return {
            namespace,
            configMaps: configMaps.status === 'fulfilled' ? configMaps.value.items : [],
            secrets: secrets.status === 'fulfilled' ? secrets.value.items : [],
            configMapCursor: configMaps.status === 'fulfilled' ? configMaps.value.continue : undefined,
            secretCursor: secrets.status === 'fulfilled' ? secrets.value.continue : undefined,
            errors: [
                ...(configMaps.status === 'rejected' ? ['Could not list ConfigMap metadata.'] : []),
                ...(secrets.status === 'rejected' ? ['Could not list Secret metadata.'] : [])
            ]
        };
    }
};
