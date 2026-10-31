import {Subject} from 'rxjs';

import {ListWatch} from './list-watch';

describe('ListWatch', () => {
    it('does not start a watch or publish results after a pending list is stopped', async () => {
        let resolveList: (value: {metadata: {resourceVersion: string}; items: any[]}) => void;
        const watch = jest.fn(() => new Subject<any>());
        const onLoad = jest.fn();
        const onChange = jest.fn();
        const listWatch = new ListWatch<any>(
            () => new Promise<{metadata: {resourceVersion: string}; items: any[]}>(resolve => (resolveList = resolve)),
            watch,
            onLoad,
            jest.fn(),
            onChange,
            jest.fn()
        );
        listWatch.start();
        listWatch.stop();
        resolveList({metadata: {resourceVersion: '1'}, items: []});
        await Promise.resolve();
        await Promise.resolve();
        expect(watch).not.toHaveBeenCalled();
        expect(onLoad).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores Kubernetes error events instead of treating status objects as resources', async () => {
        const stream = new Subject<any>();
        const onChange = jest.fn();
        const listWatch = new ListWatch(
            async () => ({metadata: {resourceVersion: '1'}, items: []}),
            () => stream,
            jest.fn(),
            jest.fn(),
            onChange,
            jest.fn()
        );

        listWatch.start();
        await Promise.resolve();
        await Promise.resolve();
        stream.next({type: 'ERROR', object: {status: 'Failure', message: 'expired'}});

        expect(onChange).toHaveBeenCalledTimes(1);
        listWatch.stop();
    });
});
