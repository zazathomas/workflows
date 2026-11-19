import * as kubernetes from 'argo-ui/src/models/kubernetes';

/**
 * The audit-relevant subset of a managedFields entry. argo-server trims the
 * per-field sets before serving templates (`informerutil.TrimManagedFields`),
 * so the UI only relies on these fields. Kubernetes adds the entry when a
 * client writes the object.
 */
export interface ManagedFieldsEntry {
    manager?: string;
    operation?: string;
    apiVersion?: string;
    time?: string;
    fieldsType?: string;
    subresource?: string;
}

interface ObjectWithMetadata {
    metadata?: kubernetes.ObjectMeta & {managedFields?: ManagedFieldsEntry[]};
}

/** Returns the managedFields entries an object carries, newest first. */
export function changeHistory(object: ObjectWithMetadata): ManagedFieldsEntry[] {
    const entries = object?.metadata?.managedFields;
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries.filter(entry => entry && typeof entry === 'object').sort((a, b) => timeOf(b) - timeOf(a));
}

/** A human action label for a managedFields operation. */
export function changeAction(entry: ManagedFieldsEntry): string {
    switch (entry.operation) {
        case 'Apply':
            return 'Applied';
        case 'Update':
            return 'Updated';
        default:
            return entry.operation || 'Changed';
    }
}

/** The most recent change, if the server reports one. */
export function lastChange(entries: ManagedFieldsEntry[]): ManagedFieldsEntry | undefined {
    return entries.find(entry => timeOf(entry) > 0) || entries[0];
}

function timeOf(entry: ManagedFieldsEntry): number {
    if (!entry.time) {
        return 0;
    }
    const time = new Date(entry.time).getTime();
    return Number.isNaN(time) ? 0 : time;
}
