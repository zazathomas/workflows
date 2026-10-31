import * as kubernetes from 'argo-ui/src/models/kubernetes';
import {WatchEvent} from 'argo-ui/src/models/kubernetes';
import {Observable} from 'rxjs';

import {RetryObservable} from './retry-observable';

interface Resource {
    metadata: kubernetes.ObjectMeta;
}

/**
 * RetryWatch allows you to watch for changes, automatically reconnecting on error.
 *
 * See @RetryObservable
 */
export class RetryWatch<T extends Resource> {
    private readonly ro: RetryObservable<WatchEvent<T>, string>;
    private resourceVersion?: string;

    constructor(watch: (resourceVersion?: string) => Observable<WatchEvent<T>>, onOpen: () => void, onEvent: (event: WatchEvent<T>) => void, onError: (error: Error) => void) {
        this.ro = new RetryObservable<kubernetes.WatchEvent<T>, string>(
            watch,
            onOpen,
            event => {
                const resourceVersion = event.object?.metadata?.resourceVersion;
                if (resourceVersion) {
                    this.resourceVersion = resourceVersion;
                }
                onEvent(event);
            },
            onError,
            () => this.resourceVersion
        );
    }

    public start(resourceVersion?: string) {
        this.stop();
        this.resourceVersion = resourceVersion;
        this.ro.start(resourceVersion);
    }

    // Must invoke on component unload.
    public stop() {
        this.ro.stop();
    }
}
