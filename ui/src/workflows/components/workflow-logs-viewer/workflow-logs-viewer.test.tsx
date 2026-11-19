import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import * as React from 'react';
import {of} from 'rxjs';

import {Context} from '../../../shared/context';
import {services} from '../../../shared/services';
import {WorkflowLogsViewer} from './workflow-logs-viewer';

jest.mock('./full-height-logs-viewer', () => ({
    FullHeightLogsViewer: ({source}: {source: {key: string; loadLogs: () => any}}) => {
        const [lines, setLines] = React.useState<string[]>([]);
        React.useEffect(() => {
            setLines([]);
            const subscription = source.loadLogs().subscribe((line: string) => setLines(previous => [...previous, line]));
            return () => subscription.unsubscribe();
        }, [source.key]);
        return <pre data-testid='log-lines'>{lines.join('')}</pre>;
    }
}));

const runtime = 'time=2026-10-31T12:44:37.208Z level=INFO msg="waiting for signals" argo=true signalPath=/var/run/argo/ctr/main/signal';
const userLog = 'time=2026-10-31T12:44:38.208Z level=INFO msg="my workflow emitted this"';
const workflow = {
    metadata: {uid: 'run-1', name: 'run-1', namespace: 'argo'},
    spec: {templates: [{name: 'main', container: {image: 'alpine'}}]},
    status: {nodes: {'run-1': {id: 'run-1', name: 'run-1', type: 'Pod', phase: 'Succeeded'}}}
} as any;

function viewer(archived = false) {
    return (
        <Context.Provider value={{popup: {}, navigation: {goto: jest.fn()}} as any}>
            <WorkflowLogsViewer workflow={workflow} initialPodName='run-1' initialNodeId='run-1' container='main' archived={archived} />
        </Context.Provider>
    );
}

test('shows user output but hides Argo internals for both live and archived logs, with a remembered override', async () => {
    window.localStorage.removeItem('SHOW_VERBOSE_POD_LOGS');
    const getLogs = jest
        .spyOn(services.workflows, 'getContainerLogs')
        .mockImplementation(() => of({podName: 'pod-1', content: runtime}, {podName: 'pod-1', content: userLog}, {podName: 'pod-1', content: 'custom workflow output'}));
    const first = render(viewer());
    const checkbox = screen.getByRole('checkbox', {name: 'Show verbose pod logs'});
    expect(checkbox).not.toBeChecked();
    await waitFor(() => expect(screen.getByTestId('log-lines')).toHaveTextContent('my workflow emitted this'));
    expect(screen.getByTestId('log-lines')).toHaveTextContent('custom workflow output');
    expect(screen.getByTestId('log-lines')).not.toHaveTextContent('waiting for signals');

    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getByTestId('log-lines')).toHaveTextContent('waiting for signals'));
    expect(window.localStorage.getItem('SHOW_VERBOSE_POD_LOGS')).toBe('true');
    first.unmount();

    render(viewer(true));
    expect(screen.getByRole('checkbox', {name: 'Show verbose pod logs'})).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('log-lines')).toHaveTextContent('waiting for signals'));
    expect(getLogs).toHaveBeenCalledWith(workflow, 'run-1', 'run-1', 'main', '', true);
    fireEvent.click(screen.getByRole('checkbox', {name: 'Show verbose pod logs'}));
    await waitFor(() => expect(screen.getByTestId('log-lines')).not.toHaveTextContent('waiting for signals'));
    expect(screen.getByTestId('log-lines')).toHaveTextContent('my workflow emitted this');
    getLogs.mockRestore();
});

test('colors the console output without changing the visible text', async () => {
    window.localStorage.removeItem('SHOW_VERBOSE_POD_LOGS');
    const getLogs = jest
        .spyOn(services.workflows, 'getContainerLogs')
        .mockImplementation(() =>
            of(
                {podName: 'pod-1', content: 'time=2026-10-31T12:44:37.208Z level=INFO msg="routine step done"'},
                {podName: 'pod-1', content: 'time=2026-10-31T12:44:38.208Z level=ERROR msg="database is down"'}
            )
        );
    render(viewer());
    await waitFor(() => expect(screen.getByTestId('log-lines')).toHaveTextContent('database is down'));
    const output = screen.getByTestId('log-lines').textContent;
    // severity styling: green info, red error
    expect(output).toContain('\u001b[32m');
    expect(output).toContain('\u001b[31m');
    // the visible text is unchanged by the styling
    expect(output).toContain('msg="routine step done"');
    // eslint-disable-next-line no-control-regex -- matching the ESC control character is the point
    expect(output.replace(/\u001b\[[0-9;]*m/g, '')).toContain('time=2026-10-31');
    getLogs.mockRestore();
});

test('the minimum level filter hides less severe and unlabeled lines', async () => {
    window.localStorage.removeItem('SHOW_VERBOSE_POD_LOGS');
    const getLogs = jest
        .spyOn(services.workflows, 'getContainerLogs')
        .mockImplementation(() =>
            of(
                {podName: 'pod-1', content: 'time=2026-10-31T12:44:37.208Z level=INFO msg="routine step done"'},
                {podName: 'pod-1', content: 'time=2026-10-31T12:44:38.208Z level=ERROR msg="database is down"'},
                {podName: 'pod-1', content: 'custom workflow output'}
            )
        );
    render(viewer());
    await waitFor(() => expect(screen.getByTestId('log-lines')).toHaveTextContent('routine step done'));
    expect(screen.getByRole('button', {name: 'Copy'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Download'})).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', {name: 'Minimum log level'}), {target: {value: 'error'}});
    await waitFor(() => expect(screen.getByTestId('log-lines')).not.toHaveTextContent('routine step done'));
    // unlabeled output is treated as info, so it is filtered out too
    expect(screen.getByTestId('log-lines')).not.toHaveTextContent('custom workflow output');
    expect(screen.getByTestId('log-lines')).toHaveTextContent('database is down');
    expect(getLogs).toHaveBeenCalledTimes(2);
    getLogs.mockRestore();
});
