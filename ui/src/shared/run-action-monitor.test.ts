import {Subject} from 'rxjs';

import {Workflow} from './models';
import {RunActionMonitor} from './run-action-monitor';
import {ACTION_MARKER_ANNOTATION} from './run-actions';
import {services} from './services';

const marker = 'NEEDS_USER_ACTION:';
const run = (uid: string, phase = 'Running') =>
    ({
        metadata: {uid, name: `job-${uid}`, namespace: 'argo', annotations: {[ACTION_MARKER_ANNOTATION]: marker}},
        spec: {},
        status: {phase, nodes: {}}
    }) as unknown as Workflow;
const event = (id: string) => ({kind: 'open-url', id, title: 'Sign in', url: 'https://github.com/login/device', code: 'ABCD'});

beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
});

test('tracks only opted-in running workflows, deduplicates and accepts renewed codes', async () => {
    const logs = new Subject<any>();
    const watch = new Subject<any>();
    jest.spyOn(services.workflows, 'get').mockImplementation(async () => run('one'));
    jest.spyOn(services.workflows, 'watch').mockReturnValue(watch);
    const logSpy = jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const onAction = jest.fn();
    const onFinish = jest.fn();
    const monitor = new RunActionMonitor('alice', onAction, onFinish, jest.fn(), jest.fn());
    monitor.start();
    monitor.setPolicy(['github.com']);
    expect(monitor.track({...run('unmarked'), metadata: {...run('unmarked').metadata, annotations: {}}} as Workflow)).toBe(false);
    expect(monitor.track(run('one'))).toBe(true);
    await Promise.resolve();
    expect(logSpy).toHaveBeenCalledWith('argo', 'job-one', marker, 'main');
    const line = (id: string) => logs.next({content: marker + JSON.stringify(event(id)), podName: 'job-one-1'});
    line('first');
    line('first');
    line('second');
    expect(onAction.mock.calls.map(([action]) => action.event.id)).toEqual(['first', 'second']);
    expect(sessionStorage.getItem('workflows-ui.run-actions.v1.alice')).not.toContain('ABCD');
    watch.next({type: 'MODIFIED', object: run('one', 'Succeeded')});
    expect(onFinish).toHaveBeenCalledWith('one');
    expect(logs.observers).toHaveLength(0);
    expect(sessionStorage.getItem('workflows-ui.run-actions.v1.alice')).toBe('[]');
    monitor.stop();
});

test('restores a tracked run after reload without restoring a device code', async () => {
    jest.spyOn(services.workflows, 'get').mockResolvedValue(run('restored'));
    jest.spyOn(services.workflows, 'watch').mockReturnValue(new Subject<any>());
    const logs = new Subject<any>();
    jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const first = new RunActionMonitor('alice', jest.fn(), jest.fn(), jest.fn(), jest.fn());
    first.start();
    first.setPolicy(['github.com']);
    first.track(run('restored'));
    await Promise.resolve();
    first.stop();
    const onAction = jest.fn();
    const restored = new RunActionMonitor('alice', onAction, jest.fn(), jest.fn(), jest.fn());
    restored.start();
    restored.setPolicy(['github.com']);
    await Promise.resolve();
    logs.next({content: marker + JSON.stringify(event('after-reload')), podName: 'job-restored-1'});
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(new RunActionMonitor('bob', jest.fn(), jest.fn(), jest.fn(), jest.fn()).track(run('new'))).toBe(true);
    expect(sessionStorage.getItem('workflows-ui.run-actions.v1.bob')).toContain('job-new');
    restored.stop();
});

test('warns when a marked log line cannot become a trusted action', async () => {
    const logs = new Subject<any>();
    jest.spyOn(services.workflows, 'get').mockResolvedValue(run('blocked'));
    jest.spyOn(services.workflows, 'watch').mockReturnValue(new Subject<any>());
    jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const onError = jest.fn();
    const monitor = new RunActionMonitor('alice', jest.fn(), jest.fn(), onError, jest.fn());
    monitor.start();
    monitor.setPolicy(['github.com']);
    monitor.track(run('blocked'));
    await Promise.resolve();
    logs.next({content: marker + JSON.stringify({...event('blocked'), url: 'https://phishing.example/login'}), podName: 'job-blocked-1'});
    expect(onError).toHaveBeenCalledWith('blocked', expect.stringContaining('ignored'));
    monitor.stop();
});

test('limits concurrent streams and starts a queued run when a slot opens', async () => {
    const watches = new Map<string, Subject<any>>();
    jest.spyOn(services.workflows, 'get').mockImplementation(async (_namespace, name) => run(name.slice('job-'.length)));
    jest.spyOn(services.workflows, 'watch').mockImplementation(({name}) => {
        if (!watches.has(name)) watches.set(name, new Subject<any>());
        return watches.get(name);
    });
    const logs = jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(new Subject<any>());
    const onChange = jest.fn();
    const monitor = new RunActionMonitor('alice', jest.fn(), jest.fn(), jest.fn(), onChange);
    monitor.start();
    monitor.setPolicy(['github.com']);
    for (let index = 0; index < 5; index++) monitor.track(run(String(index)));
    await Promise.resolve();
    expect(logs).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenLastCalledWith(expect.any(Array), 1);
    watches.get('job-0').next({type: 'MODIFIED', object: run('0', 'Succeeded')});
    await Promise.resolve();
    expect(logs).toHaveBeenCalledTimes(5);
    expect(onChange).toHaveBeenLastCalledWith(expect.any(Array), 0);
    monitor.stop();
});

test('stops streaming when administrator approval is revoked and rechecks logs if restored', async () => {
    const logs = new Subject<any>();
    jest.spyOn(services.workflows, 'get').mockResolvedValue(run('policy'));
    jest.spyOn(services.workflows, 'watch').mockReturnValue(new Subject<any>());
    jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const onAction = jest.fn();
    const monitor = new RunActionMonitor('alice', onAction, jest.fn(), jest.fn(), jest.fn());
    monitor.start();
    monitor.setPolicy(['github.com']);
    monitor.track(run('policy'));
    await Promise.resolve();
    logs.next({content: marker + JSON.stringify(event('one')), podName: 'job-policy-1'});
    expect(onAction).toHaveBeenCalledTimes(1);
    monitor.setPolicy([]);
    expect(logs.observers).toHaveLength(0);
    monitor.setPolicy(['github.com']);
    await Promise.resolve();
    logs.next({content: marker + JSON.stringify(event('one')), podName: 'job-policy-1'});
    expect(onAction).toHaveBeenCalledTimes(2);
    monitor.stop();
});

test('retries a failed log stream while the workflow is active and reports lost access', async () => {
    jest.useFakeTimers();
    try {
        const first = new Subject<any>();
        const second = new Subject<any>();
        jest.spyOn(services.workflows, 'get').mockResolvedValue(run('retry'));
        jest.spyOn(services.workflows, 'watch').mockReturnValue(new Subject<any>());
        const logs = jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValueOnce(first).mockReturnValueOnce(second);
        const onError = jest.fn();
        const onAction = jest.fn();
        const monitor = new RunActionMonitor('alice', onAction, jest.fn(), onError, jest.fn());
        monitor.start();
        monitor.setPolicy(['github.com']);
        monitor.track(run('retry'));
        await Promise.resolve();
        first.error(new Error('pod logs forbidden'));
        expect(onError).toHaveBeenCalledWith('retry', expect.stringContaining('pod-log access'));
        jest.advanceTimersByTime(1000);
        expect(logs).toHaveBeenCalledTimes(2);
        second.next({content: marker + JSON.stringify(event('renewed')), podName: 'job-retry-1'});
        expect(onAction).toHaveBeenCalledTimes(1);
        monitor.stop();
        expect(second.observers).toHaveLength(0);
    } finally {
        jest.useRealTimers();
    }
});
