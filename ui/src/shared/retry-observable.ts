import {Observable, Subscription} from 'rxjs';

/**
 * RetryObservable allows you to watch for changes, automatically reconnecting on error.
 */
export class RetryObservable<E, V> {
    private readonly watch: (v: V) => Observable<E>;
    private readonly onOpen: () => void;
    private readonly onItem: (event: E) => void;
    private readonly onError: (error: Error) => void;
    private readonly getRetryValue?: () => V;
    private retryValue?: V;
    private subscription: Subscription;
    private timeout: any; // should be `number`
    private reconnectAfterMs = 3000;

    constructor(
        watch: (v?: V) => Observable<E>,
        onOpen: () => void, //  called when watches (re-)established after error, so should clear any errors
        onEvent: (event: E) => void, // called whenever item is received,
        onError: (error: Error) => void,
        getRetryValue?: () => V
    ) {
        this.watch = watch;
        this.onOpen = onOpen;
        this.onItem = onEvent;
        this.onError = onError;
        this.getRetryValue = getRetryValue;
    }

    public start(v?: V) {
        this.stop();
        if (v !== undefined) {
            this.retryValue = v;
        }
        this.subscription = this.watch(v).subscribe({
            next: next => {
                if (next) {
                    this.onItem(next);
                } else {
                    this.reconnectAfterMs = 3000;
                    this.onOpen();
                }
            },
            error: e => {
                this.stop();
                this.onError(e);
                this.reconnect();
            }
        });
    }

    // Must invoke on component unload.
    public stop() {
        clearTimeout(this.timeout);
        if (this.subscription) {
            this.subscription.unsubscribe();
        }
    }

    private reconnect() {
        this.timeout = setTimeout(() => this.start(this.getRetryValue ? this.getRetryValue() : this.retryValue), this.reconnectAfterMs);
        this.reconnectAfterMs = Math.min(this.reconnectAfterMs * 1.5, 60000);
    }
}
