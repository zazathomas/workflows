import {expect, Page, test} from '@playwright/test';

import {CellColor, WorkflowLogsPanel} from '../pages/workflow-logs-panel';

// The workflow whose logs the (mock) server streams: one pod, one container.
const workflow = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {name: 'sample-run', namespace: 'argo', uid: 'run-1', creationTimestamp: '2025-01-01T00:00:00Z', labels: {team: 'platform'}},
    spec: {
        arguments: {parameters: [{name: 'message', value: 'hello'}]},
        templates: [{name: 'main', container: {image: 'alpine'}}]
    },
    status: {
        phase: 'Succeeded',
        startedAt: '2025-01-01T00:00:00Z',
        finishedAt: '2025-01-01T00:01:00Z',
        conditions: [],
        nodes: {'sample-run': {id: 'sample-run', name: 'sample-run', displayName: 'sample-run', type: 'Pod', phase: 'Succeeded', templateName: 'main', children: []}}
    }
};

// What the containers printed, in the formats a real workflow emits: logfmt
// (argo's own containers) and plain container output. Kept short enough to
// stay on one row of the side panel's terminal.
const logLines = ['time=12:44:37Z level=INFO msg="step done"', 'level=ERROR msg="database is down"', 'custom workflow output'];

async function mockApi(page: Page) {
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        let json: unknown = {};
        if (path.endsWith('/info')) json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path.endsWith('/userinfo')) json = {subject: 'test-user', serviceAccountNamespace: 'argo'};
        else if (path.endsWith('/version')) json = {version: 'test'};
        else if (path.endsWith('/namespaces')) json = {items: ['argo']};
        else if (path.endsWith('/workflows/argo/sample-run/log')) {
            // mirror the server's server-side grep so filtering is observable
            const grep = url.searchParams.get('grep') || '';
            const matching = grep ? logLines.filter(line => new RegExp(grep).test(line)) : logLines;
            return route.fulfill({
                status: 200,
                contentType: 'text/event-stream',
                body: matching.map(content => `data: ${JSON.stringify({result: {podName: 'sample-run', content}})}\n\n`).join('')
            });
        } else if (path.endsWith('/workflows/argo/sample-run')) json = workflow;
        else if (path.includes('/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)});
    });
}

async function openLogs(page: Page): Promise<WorkflowLogsPanel> {
    await page.goto('/workflows/argo/sample-run');
    await page.getByRole('button', {name: 'Logs', exact: true}).click();
    const logs = new WorkflowLogsPanel(page);
    await expect(logs.heading).toBeVisible();
    return logs;
}

/** Whether any cell of the line was colored with the given xterm palette index. */
function colored(colors: CellColor[], paletteIndex: number): boolean {
    return colors.some(({mode, color}) => mode === 'palette' && color === paletteIndex);
}

test('the console colors severity, timestamps and pod names', async ({page}) => {
    await mockApi(page);
    const logs = await openLogs(page);
    // the panel opens on "All" pods, so every line carries its pod's name
    await expect.poll(() => logs.text(), {timeout: 15_000}).toContain('step done');
    const text = await logs.text();
    expect(text).toContain('sample-run: time=12:44:37Z level=INFO msg="step done"');
    expect(text).toContain('sample-run: level=ERROR msg="database is down"');
    expect(text).toContain('sample-run: custom workflow output');

    // severity words: green info (2), red error (1)
    expect(colored(await logs.foregroundColors('level=INFO'), 2)).toBe(true);
    expect(colored(await logs.foregroundColors('level=ERROR'), 1)).toBe(true);
    // the pod prefix keeps pods apart in the all-pods view: cyan (6)
    expect(colored(await logs.foregroundColors('sample-run:'), 6)).toBe(true);
    // timestamps recede: bright black (8)
    expect(colored(await logs.foregroundColors('time=12:44:37Z'), 8)).toBe(true);
    // unstyled output still reads well on the dark console: light gray (250)
    expect(colored(await logs.foregroundColors('custom workflow output'), 250)).toBe(true);
});

test('the minimum level filter narrows the console', async ({page}) => {
    await mockApi(page);
    const logs = await openLogs(page);
    await expect.poll(() => logs.text(), {timeout: 15_000}).toContain('step done');

    await page.getByRole('combobox', {name: 'Minimum log level'}).selectOption('error');
    await expect.poll(() => logs.text(), {timeout: 15_000}).not.toContain('step done');
    const text = await logs.text();
    expect(text).toContain('database is down');
    // unlabeled output is treated as info, so it is filtered out too
    expect(text).not.toContain('custom workflow output');
});

test('the search filter refetches and highlights matches', async ({page}) => {
    await mockApi(page);
    const logs = await openLogs(page);
    await expect.poll(() => logs.text(), {timeout: 15_000}).toContain('step done');

    await page.getByRole('searchbox', {name: 'Filter logs (regular expression)'}).fill('database');
    // the server refetches with the pattern, so only matching lines remain
    await expect.poll(() => logs.text(), {timeout: 15_000}).not.toContain('step done');
    expect(await logs.text()).toContain('database is down');
    // and the matches stand out on a bright yellow (11) background
    expect(colored(await logs.backgroundColors('database'), 11)).toBe(true);
});

test('copy and download expose the plain text', async ({page, context}) => {
    await mockApi(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const logs = await openLogs(page);
    await expect.poll(() => logs.text(), {timeout: 15_000}).toContain('step done');

    await page.getByRole('button', {name: 'Copy', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Copied!'})).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('step done');
    expect(clipboard).toContain('custom workflow output');
    // the clipboard holds what the container printed, not the console styling
    expect(clipboard).not.toContain('\u001b');

    const download = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Download', exact: true}).click();
    expect((await download).suggestedFilename()).toBe('sample-run-all-pods-main.log');
});

test('aggregates logs archived to the artifact repository across pods in the all-pods view', async ({page}) => {
    // A completed workflow whose pods are gone: each pod archived its logs to
    // the artifact repository (e.g. S3), so only the per-node artifact
    // endpoints can serve them.
    const twoStepWorkflow = {
        ...workflow,
        metadata: {...workflow.metadata, uid: 'run-archived'},
        status: {
            ...workflow.status,
            nodes: {
                'node-a': {
                    id: 'node-a',
                    name: 'sample-run.step-a',
                    displayName: 'Step A',
                    templateName: 'step',
                    type: 'Pod',
                    phase: 'Succeeded',
                    outputs: {artifacts: [{name: 'main-logs'}]}
                },
                'node-b': {
                    id: 'node-b',
                    name: 'sample-run.step-b',
                    displayName: 'Step B',
                    templateName: 'step',
                    type: 'Pod',
                    phase: 'Succeeded',
                    outputs: {artifacts: [{name: 'main-logs'}]}
                }
            }
        }
    };
    let liveLogRequests = 0;
    const artifactRequests: string[] = [];
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        let json: unknown = {};
        if (path.endsWith('/info')) json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path.endsWith('/userinfo')) json = {subject: 'test-user', serviceAccountNamespace: 'argo'};
        else if (path.endsWith('/version')) json = {version: 'test'};
        else if (path.endsWith('/namespaces')) json = {items: ['argo']};
        else if (path.endsWith('/workflows/argo/sample-run/log')) {
            // the pods are gone: a live pod-log request cannot serve anything
            liveLogRequests++;
            return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({message: 'pods are gone'})});
        } else if (path.endsWith('/workflows/argo/sample-run')) json = twoStepWorkflow;
        else if (path.includes('/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)});
    });
    await page.route('**/artifact-files/**', async route => {
        const path = new URL(route.request().url()).pathname;
        artifactRequests.push(path);
        const body = path.includes('/node-a/') ? 'hello from step A\nsecond line from A' : 'hello from step B';
        return route.fulfill({status: 200, contentType: 'text/plain', body});
    });

    await page.goto('/workflows/argo/sample-run');
    await page.getByRole('button', {name: 'Logs', exact: true}).click();
    const logs = new WorkflowLogsPanel(page);
    await expect(logs.heading).toBeVisible();

    // both pods' archived logs appear, in node order, attributed to their node
    await expect.poll(() => logs.text(), {timeout: 15_000}).toContain('Step B: hello from step B');
    const text = await logs.text();
    expect(text).toContain('Step A: hello from step A');
    expect(text).toContain('second line from A');
    expect(text.indexOf('Step A:')).toBeLessThan(text.indexOf('Step B:'));

    // the archived copy was read instead of the unreachable live pod logs
    expect(liveLogRequests).toBe(0);
    expect(artifactRequests).toHaveLength(2);
});
