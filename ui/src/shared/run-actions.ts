// The workflows-ui- annotation names are persisted on Jobs and Runs. Keep
// them stable when changing display branding; no upstream CRDs are modified.
export const ACTION_MARKER_ANNOTATION = 'workflows-ui-action-marker';
export const ACTION_CONTAINER_ANNOTATION = 'workflows-ui-action-container';

export interface RunActionConfig {
    marker: string;
    container: string;
}

export interface RunActionEvent {
    id: string;
    kind: 'open-url';
    title: string;
    url: string;
    host: string;
    code?: string;
    expiresAt?: string;
}

const MARKER_PATTERN = /^[a-zA-Z0-9_.:-]{1,80}$/;
const CONTAINER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

export function configFromAnnotations(annotations?: Record<string, string>): RunActionConfig | null {
    const marker = annotations?.[ACTION_MARKER_ANNOTATION];
    const container = annotations?.[ACTION_CONTAINER_ANNOTATION] || 'main';
    if (!marker || !MARKER_PATTERN.test(marker) || !CONTAINER_PATTERN.test(container)) {
        return null;
    }
    return {marker, container};
}

// SubmitOpts.Annotations uses comma-separated key=value entries. Only the
// validated marker and container are copied, never a link or one-time code.
export function submitAnnotations(config: RunActionConfig): string {
    return `${ACTION_MARKER_ANNOTATION}=${config.marker},${ACTION_CONTAINER_ANNOTATION}=${config.container}`;
}

export function parseRunActionLine(content: string, marker: string, allowedHosts: string[], now = Date.now()): RunActionEvent | null {
    if (!MARKER_PATTERN.test(marker) || content.length > 4096 || !content.startsWith(marker)) {
        return null;
    }
    try {
        const data = JSON.parse(content.slice(marker.length).trim());
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.kind !== 'open-url' || typeof data.id !== 'string' || !ID_PATTERN.test(data.id)) {
            return null;
        }
        if (typeof data.url !== 'string' || data.url.length > 2048 || typeof data.title !== 'string' || data.title.length > 120 || !data.title.trim()) {
            return null;
        }
        if (data.code !== undefined && (typeof data.code !== 'string' || data.code.length > 128)) {
            return null;
        }
        if (data.expiresAt !== undefined && (typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now)) {
            return null;
        }
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.endsWith('.') || !allowedHosts.includes(url.hostname)) {
            return null;
        }
        return {
            kind: 'open-url',
            id: data.id,
            title: data.title.trim(),
            url: url.href,
            host: url.hostname,
            ...(data.code ? {code: data.code} : {}),
            ...(data.expiresAt ? {expiresAt: data.expiresAt} : {})
        };
    } catch {
        return null;
    }
}
