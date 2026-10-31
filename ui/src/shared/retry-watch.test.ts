import {WatchEvent} from 'argo-ui/src/models/kubernetes';
import {Subject} from 'rxjs';

import {RetryWatch} from './retry-watch';

interface Resource {
    metadata: {
        resourceVersion?: string;
    };
}

describe('RetryWatch', () => {
    it('passes watch error events through without requiring resource metadata', () => {
        const stream = new Subject<WatchEvent<Resource>>();
        const onEvent = jest.fn();
        const retryWatch = new RetryWatch<Resource>(() => stream, jest.fn(), onEvent, jest.fn());

        retryWatch.start('initial');
        stream.next({type: 'ERROR', object: {} as Resource});

        expect(onEvent).toHaveBeenCalledWith({type: 'ERROR', object: {}});
        retryWatch.stop();
    });
});
