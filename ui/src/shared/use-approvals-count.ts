import {useEffect, useState} from 'react';

import {services} from './services';

const POLL_INTERVAL_MS = 30000;

/**
 * One shared poll per namespace, ref-counted across the consumers of
 * `useApprovalsCount` (the Runs nav item's attention dot and the Runs page's
 * approvals strip): while several are mounted, only a single request is made
 * per interval. The first subscriber starts the poll, the last one out stops
 * it, and late joiners receive the current count right away. The poll pauses
 * while the tab is hidden and catches up when it becomes visible again.
 */
class ApprovalsCountStore {
    private count: number | undefined;
    private readonly listeners = new Set<(count: number | undefined) => void>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling = false;

    constructor(
        private readonly namespace: string,
        private readonly onStop: () => void
    ) {}

    subscribe(listener: (count: number | undefined) => void): () => void {
        this.listeners.add(listener);
        if (this.listeners.size === 1) {
            this.start();
        } else {
            // Late joiner: hand over the current count instead of making it
            // wait for the next tick.
            listener(this.count);
        }
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
                this.onStop();
            }
        };
    }

    private start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    private stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    private readonly onVisibilityChange = () => {
        if (!document.hidden) {
            this.poll();
        }
    };

    private async poll() {
        // Skip while the tab is hidden; the next visible tick catches up.
        if (this.polling || (typeof document !== 'undefined' && document.hidden)) {
            return;
        }
        this.polling = true;
        try {
            this.set(await services.workflows.approvalCount(this.namespace));
        } catch {
            this.set(undefined);
        } finally {
            this.polling = false;
        }
    }

    private set(count: number | undefined) {
        this.count = count;
        this.listeners.forEach(listener => listener(count));
    }
}

const stores = new Map<string, ApprovalsCountStore>();

function storeFor(namespace: string): ApprovalsCountStore {
    // Stores are dropped again once their last listener leaves, so the map
    // only holds the namespaces with active consumers.
    let store = stores.get(namespace);
    if (!store) {
        store = new ApprovalsCountStore(namespace, () => stores.delete(namespace));
        stores.set(namespace, store);
    }
    return store;
}

/**
 * Polls the number of run steps waiting on a human (suspended steps of
 * running runs) for the Runs nav item's attention dot and the Runs page's
 * approvals strip. Consumers share one poll per namespace. The poll pauses
 * while the tab is hidden and stops entirely when disabled (for example in
 * tests or when the user cannot list runs).
 */
export function useApprovalsCount(namespace: string, enabled = true): number | undefined {
    const [count, setCount] = useState<number | undefined>(undefined);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        const store = storeFor(namespace);
        return store.subscribe(setCount);
    }, [namespace, enabled]);

    return count;
}
