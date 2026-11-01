import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryHistory} from 'history';
import * as React from 'react';
import {useContext} from 'react';
import {Subject} from 'rxjs';

import {Workflow} from '../shared/models';
import {RunActionContext} from '../shared/run-action-context';
import {ACTION_MARKER_ANNOTATION} from '../shared/run-actions';
import {services} from '../shared/services';
import {RunActionProvider} from './run-action-provider';

const marker = 'NEEDS_USER_ACTION:';
const workflow = {
    metadata: {uid: 'run-1', name: 'job-run', namespace: 'argo', annotations: {[ACTION_MARKER_ANNOTATION]: marker}},
    spec: {},
    status: {phase: 'Running', nodes: {}}
} as unknown as Workflow;

function TrackButton() {
    const actions = useContext(RunActionContext);
    return <button onClick={() => actions.track(workflow)}>Run job</button>;
}

beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
});

test('shows sequential requests anywhere in the UI and returns to this run on link click', async () => {
    const logs = new Subject<any>();
    const watch = new Subject<any>();
    jest.spyOn(services.runActions, 'allowedHosts').mockResolvedValue(['github.com']);
    jest.spyOn(services.workflows, 'get').mockResolvedValue(workflow);
    jest.spyOn(services.workflows, 'watch').mockReturnValue(watch);
    jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const history = createMemoryHistory({initialEntries: ['/workflows/argo/job-run']});
    render(
        <RunActionProvider subject='alice' history={history}>
            <TrackButton />
        </RunActionProvider>
    );
    fireEvent.click(screen.getByRole('button', {name: 'Run job'}));
    await waitFor(() => expect(logs.observers).toHaveLength(1));
    act(() => {
        history.push('/reports');
        logs.next({
            content: marker + JSON.stringify({kind: 'open-url', id: 'first', title: 'Sign in', url: 'https://github.com/login/device', code: 'ABCD'}),
            podName: 'job-run-1'
        });
        logs.next({content: marker + JSON.stringify({kind: 'open-url', id: 'second', title: 'Sign in again', url: 'https://github.com/login/device'}), podName: 'job-run-1'});
    });
    expect(await screen.findByRole('dialog', {name: 'Sign in'})).toBeInTheDocument();
    expect(screen.getByText('ABCD')).toBeInTheDocument();
    expect(screen.getByRole('link', {name: /Open github.com/})).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('link', {name: /Open github.com/}));
    await waitFor(() => expect(history.location.pathname).toBe('/workflows/argo/job-run'));
    expect(await screen.findByRole('dialog', {name: 'Sign in again'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Close run action'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Action required (2)'}));
    expect(await screen.findByRole('dialog', {name: 'Sign in'})).toBeInTheDocument();
    act(() => watch.next({type: 'MODIFIED', object: {...workflow, status: {...workflow.status, phase: 'Succeeded'}}}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', {name: 'Action required (2)'})).not.toBeInTheDocument();
});

test('the action indicator can cancel a request without opening it', async () => {
    const logs = new Subject<any>();
    jest.spyOn(services.runActions, 'allowedHosts').mockResolvedValue(['github.com']);
    jest.spyOn(services.workflows, 'get').mockResolvedValue(workflow);
    jest.spyOn(services.workflows, 'watch').mockReturnValue(new Subject<any>());
    jest.spyOn(services.workflows, 'watchRunActionLogs').mockReturnValue(logs);
    const history = createMemoryHistory();
    render(
        <RunActionProvider subject='alice' history={history}>
            <TrackButton />
        </RunActionProvider>
    );
    fireEvent.click(screen.getByRole('button', {name: 'Run job'}));
    await waitFor(() => expect(logs.observers).toHaveLength(1));
    act(() => {
        logs.next({content: marker + JSON.stringify({kind: 'open-url', id: 'only', title: 'Sign in', url: 'https://github.com/login/device'}), podName: 'job-run-1'});
    });
    expect(await screen.findByRole('dialog', {name: 'Sign in'})).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', {name: /Action required/})).not.toBeInTheDocument();
    // A new event for the same run still prompts, so cancelling one request does not stop monitoring.
    act(() => {
        logs.next({content: marker + JSON.stringify({kind: 'open-url', id: 'renewed', title: 'Sign in again', url: 'https://github.com/login/device'}), podName: 'job-run-1'});
    });
    expect(await screen.findByRole('dialog', {name: 'Sign in again'})).toBeInTheDocument();
});

test('does not connect to pod logs without administrator-approved hosts', async () => {
    jest.spyOn(services.runActions, 'allowedHosts').mockResolvedValue([]);
    jest.spyOn(services.workflows, 'get').mockResolvedValue(workflow);
    const logs = jest.spyOn(services.workflows, 'watchRunActionLogs');
    const history = createMemoryHistory();
    render(
        <RunActionProvider subject='alice' history={history}>
            <TrackButton />
        </RunActionProvider>
    );
    fireEvent.click(screen.getByRole('button', {name: 'Run job'}));
    expect(await screen.findByText(/links are disabled/)).toBeInTheDocument();
    expect(logs).not.toHaveBeenCalled();
});
