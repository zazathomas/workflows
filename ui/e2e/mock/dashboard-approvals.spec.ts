import {expect, Page, test} from '@playwright/test';

const runningWorkflow = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
        name: 'waiting-run',
        namespace: 'argo',
        uid: 'run-waiting',
        creationTimestamp: '2025-06-01T00:00:00Z',
        labels: {'workflows.argoproj.io/workflow-template': 'approval-job'}
    },
    spec: {},
    status: {
        phase: 'Running',
        startedAt: '2025-06-01T00:00:00Z',
        conditions: [],
        nodes: {
            'waiting-run': {id: 'waiting-run', name: 'waiting-run', displayName: 'waiting-run', type: 'Pod', phase: 'Succeeded', children: ['wait-approval']},
            'wait-approval': {
                id: 'wait-approval',
                name: 'wait-approval',
                displayName: 'wait-approval',
                type: 'Suspend',
                phase: 'Running',
                startedAt: '2025-06-01T00:00:00Z',
                children: []
            }
        }
    }
};

const createdWorkflow = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {name: 'scheduled-job-abc123', namespace: 'argo', uid: 'run-created'},
    spec: {},
    status: {phase: 'Pending', conditions: []}
};

async function mockApi(page: Page) {
    const created: any[] = [];
    const decisions: Array<{path: string; body: any}> = [];
    await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let json: unknown = {};
        if (path.endsWith('/extensions/run-action-policy')) json = {allowedHosts: []};
        else if (path.endsWith('/info')) json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path.endsWith('/userinfo')) json = {subject: 'test-user', serviceAccountNamespace: 'argo'};
        else if (path.endsWith('/version')) json = {version: 'test'};
        else if (path.endsWith('/namespaces')) json = {items: ['argo']};
        else if (path.endsWith('/cron-workflows/argo') || path.endsWith('/cron-workflows/') || path.endsWith('/cron-workflows'))
            json = {
                items: [
                    {
                        metadata: {name: 'scheduled-job', namespace: 'argo', creationTimestamp: '2025-01-01T00:00:00Z'},
                        spec: {schedules: ['0 * * * *'], timezone: 'UTC'}
                    }
                ]
            };
        else if (path.includes('/extensions/approvals/')) {
            // POST /api/v1/extensions/approvals/{namespace}/{workflow}/{nodeId}
            decisions.push({path, body: request.postDataJSON()});
            json = {};
        } else if (path.endsWith('/extensions/run-view')) {
            json =
                new URL(request.url()).searchParams.get('view') === 'gate-count'
                    ? {count: decisions.length > 0 ? 0 : 1}
                    : {metadata: {resourceVersion: '1'}, items: decisions.length > 0 ? [] : [runningWorkflow, createdWorkflow]};
        } else if (path.endsWith('/workflows/argo') && request.method() === 'POST') {
            created.push(request.postDataJSON());
            json = createdWorkflow;
        } else if (path.endsWith('/workflows/argo/waiting-run')) json = runningWorkflow;
        else if (path.endsWith('/workflows/argo/scheduled-job-abc123')) json = createdWorkflow;
        else if (path.endsWith('/workflows/argo') || path.endsWith('/workflows/') || path.endsWith('/workflows'))
            json = {metadata: {resourceVersion: '1'}, items: [runningWorkflow, createdWorkflow]};
        else if (path.includes('/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)});
    });
    return {created, decisions};
}

test('the dashboard is the landing page and summarizes runs', async ({page}) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', {name: 'Overview'})).toBeVisible();
    // KPI cards derived from the listed runs
    await expect(page.getByText('Running now')).toBeVisible();
    await expect(page.getByText('Runs today')).toBeVisible();
    // the runs-per-day chart renders one column per day
    await expect(page.getByRole('img', {name: /Runs per day/})).toBeVisible();
    // upcoming schedules come from the cron workflow list
    await expect(page.getByRole('link', {name: 'scheduled-job'})).toBeVisible();
});

test('the dashboard shows most-run jobs and a failed-first toggle on recent runs', async ({page}) => {
    await mockApi(page);
    await page.goto('/dashboard');
    // The waiting run carries the approval-job template label.
    await expect(page.getByRole('region', {name: 'Most-run jobs'})).toContainText('approval-job');
    // The failed-first toggle re-sorts the recent runs list.
    const toggle = page.getByRole('button', {name: 'Failed first'});
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('the approvals queue lists suspended steps and resumes them on approve', async ({page}) => {
    const {decisions} = await mockApi(page);
    await page.goto('/approvals');
    const row = page.getByRole('row', {name: /waiting-run/});
    await expect(row).toBeVisible();
    await expect(row).toContainText('wait-approval');
    await expect(row).toContainText('approval-job');
    await row.getByRole('button', {name: 'Approve wait-approval on waiting-run'}).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toMatchObject({
        path: '/api/v1/extensions/approvals/argo/waiting-run/wait-approval',
        body: {decision: 'approve', workflowUID: 'run-waiting', startedAt: '2025-06-01T00:00:00Z'}
    });
});

test('a schedule can be run now without waiting for its next run', async ({page}) => {
    const {created} = await mockApi(page);
    await page.goto('/cron-workflows/argo');
    await page.getByRole('button', {name: 'Run schedule scheduled-job now'}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/scheduled-job-abc123/);
    expect(created).toHaveLength(1);
    expect(created[0].workflow).toMatchObject({
        metadata: {
            generateName: 'scheduled-job-',
            namespace: 'argo',
            labels: {'workflows.argoproj.io/cron-workflow': 'scheduled-job'}
        }
    });
});

test('the approvals signal shows on the Runs nav item and the Runs page strip', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    // The strip polls the suspended steps of running runs: one waiting step.
    await expect(page.locator('.workflows-list__approvals-strip')).toHaveText(/1 step is waiting for your approval/);
    // The strip links to the approvals queue; the navbar carries no Approvals entry.
    await expect(page.getByRole('link', {name: 'Review'})).toHaveAttribute('href', '/approvals/argo');
    await expect(page.getByRole('button', {name: 'Approvals'})).toHaveCount(0);
    // The Runs nav item carries the attention dot, and only that item does.
    await expect(page.locator('.modern-layout__item.has-attention')).toHaveText(/Runs/);
    await expect(page.locator('.modern-layout__item.has-attention')).toHaveCount(1);
});

test('the Queued saved view shows only runs waiting on a synchronization lock', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo?synchronization=waiting');
    // The waiting run has no synchronization status: filtered out.
    await expect(page.getByRole('row', {name: /waiting-run/})).toHaveCount(0);
    // The queued-only toggle is engaged and reflected in the URL.
    await expect(page.getByRole('button', {name: /Queued only/})).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/synchronization=waiting/);
});

test('the keyboard shortcut sheet opens with ? and closes again', async ({page}) => {
    await mockApi(page);
    await page.goto('/dashboard');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', {name: 'Keyboard shortcuts'})).toBeVisible();
    await expect(page.getByRole('dialog', {name: 'Keyboard shortcuts'})).toContainText('Go to Runs');
    await page.keyboard.press('Escape');
    // The sheet closes via its Close button (Escape is not a shortcut key).
    await page.getByRole('button', {name: 'Close'}).click();
    await expect(page.getByRole('dialog', {name: 'Keyboard shortcuts'})).toHaveCount(0);
});
