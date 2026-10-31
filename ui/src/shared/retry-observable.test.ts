import {Subject} from 'rxjs';

import {RetryObservable} from './retry-observable';

describe('RetryObservable', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('reconnects with the latest watch value', () => {
        jest.useFakeTimers();
        const first = new Subject<string>();
        const second = new Subject<string>();
        const watch = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        let retryValue = 'initial';
        const retry = new RetryObservable(
            watch,
            jest.fn(),
            () => {
                retryValue = 'latest';
            },
            jest.fn(),
            () => retryValue
        );

        retry.start('initial');
        first.next('event');
        first.error(new Error('connection lost'));
        jest.advanceTimersByTime(3000);

        expect(watch).toHaveBeenNthCalledWith(2, 'latest');
        retry.stop();
    });
});
