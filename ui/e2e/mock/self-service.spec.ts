import {expect, Page, test} from '@playwright/test';

const template = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: {name: 'sample-job', namespace: 'argo', labels: {team: 'platform'}, annotations: {'workflows.argoproj.io/description': 'A test job'}},
    spec: {
        entrypoint: 'main',
        arguments: {parameters: [{name: 'message', value: 'default', description: 'Text the job prints when it runs.'}]},
        templates: [{name: 'main', container: {image: 'alpine'}}]
    }
};
const clusterTemplate = {
    ...template,
    kind: 'ClusterWorkflowTemplate',
    metadata: {name: 'shared-job', labels: {team: 'platform'}, annotations: {'workflows.argoproj.io/description': 'Shared test job'}}
};
const workflow = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {name: 'sample-run', namespace: 'argo', uid: 'run-1', creationTimestamp: '2025-01-01T00:00:00Z', labels: {team: 'platform'}},
    spec: {arguments: {parameters: [{name: 'message', value: 'hello'}]}},
    status: {
        phase: 'Succeeded',
        startedAt: '2025-01-01T00:00:00Z',
        finishedAt: '2025-01-01T00:01:00Z',
        conditions: [],
        nodes: {'sample-run': {id: 'sample-run', name: 'sample-run', displayName: 'sample-run', type: 'Pod', phase: 'Succeeded', children: []}}
    }
};

async function mockApi(page: Page, failFirst = false) {
    let attempts = 0;
    const submissions: unknown[] = [];
    await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let json: unknown = {};
        let status = 200;
        if (path.endsWith('/extensions/run-action-policy')) json = {allowedHosts: []};
        else if (path.endsWith('/info')) json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path.endsWith('/userinfo')) json = {subject: 'test-user', serviceAccountNamespace: 'argo'};
        else if (path.endsWith('/version')) json = {version: 'test'};
        else if (path.endsWith('/namespaces')) json = {items: ['argo']};
        else if (path.endsWith('/cron-workflows/argo'))
            json = {
                items: [
                    {
                        metadata: {name: 'scheduled-job', namespace: 'argo', creationTimestamp: '2025-01-01T00:00:00Z'},
                        spec: {schedules: ['0 * * * *'], timezone: 'UTC', suspend: true}
                    }
                ]
            };
        else if (path.endsWith('/cluster-workflow-templates/shared-job')) json = clusterTemplate;
        else if (path.endsWith('/cluster-workflow-templates')) {
            if (request.method() === 'POST') {
                submissions.push(request.postDataJSON());
                json = clusterTemplate;
            } else json = {metadata: {resourceVersion: '1'}, items: [clusterTemplate]};
        } else if (path.endsWith('/workflow-templates/argo/sample-job')) json = template;
        else if (path.endsWith('/workflow-templates/argo')) {
            if (request.method() === 'POST') {
                submissions.push(request.postDataJSON());
                json = template;
            } else json = {metadata: {resourceVersion: '1'}, items: [template]};
        } else if (path.endsWith('/workflows/argo/submit') && request.method() === 'POST') {
            submissions.push(request.postDataJSON());
            attempts++;
            if (failFirst && attempts === 1) {
                status = 500;
                json = {message: 'Submission failed'};
            } else json = workflow;
        } else if (path.endsWith('/workflows/argo/sample-run')) json = workflow;
        else if (path.endsWith('/workflows/argo'))
            json = {metadata: {resourceVersion: '1'}, items: [workflow, {...workflow, metadata: {...workflow.metadata, name: 'alpha-run', uid: 'run-2'}}]};
        else if (path.includes('/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
        await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(json)});
    });
    return submissions;
}

test('Run logs default to hiding internals and remember the verbose toggle', async ({page}) => {
    await mockApi(page);
    let opened = 0;
    await page.route('**/api/v1/workflows/argo/sample-run/log?*', route => {
        opened++;
        return route.fulfill({
            contentType: 'text/event-stream',
            body: [
                'time=2026-10-31T12:44:37.208Z level=INFO msg="waiting for signals" argo=true signalPath=/var/run/argo/ctr/main/signal',
                'time=2026-10-31T12:44:38.208Z level=INFO msg="my workflow emitted this"',
                'custom workflow output'
            ]
                .map(content => `data: ${JSON.stringify({result: {podName: 'sample-run', content}})}\n\n`)
                .join('')
        });
    });
    await page.goto('/workflows/argo/sample-run');
    await page.getByRole('button', {name: 'Logs', exact: true}).click();
    const checkbox = page.getByRole('checkbox', {name: 'Show verbose pod logs'});
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('textbox', {name: 'Terminal input'})).toBeVisible();
    await expect.poll(() => opened).toBeGreaterThan(0);
    const initiallyOpened = opened;
    await checkbox.check();
    await expect.poll(() => opened).toBeGreaterThan(initiallyOpened);
    await page.reload();
    await expect(checkbox).toBeChecked();
    await expect(page.getByRole('textbox', {name: 'Terminal input'})).toBeVisible();
});

test('an event for an unapproved host is skipped and reported, not offered', async ({page}) => {
    await mockApi(page);
    const markedTemplate = {...template, metadata: {...template.metadata, annotations: {...template.metadata.annotations, 'workflows-ui-action-marker': 'NEEDS_USER_ACTION:'}}};
    await page.route('**/api/v1/userinfo', route => route.fulfill({contentType: 'application/json', body: '{}'}));
    await page.route('**/api/v1/extensions/run-action-policy', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({allowedHosts: ['github.com']})}));
    await page.route(/\/api\/v1\/workflow-templates\/argo(?:\?.*)?$/, route => route.fulfill({contentType: 'application/json', body: JSON.stringify({items: [markedTemplate]})}));
    await page.route('**/api/v1/workflows/argo/sample-run', route =>
        route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})})
    );
    await page.route('**/api/v1/workflows/argo/submit', route =>
        route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})})
    );
    const rejected = {kind: 'open-url', id: 'rejected-1', title: 'REJECTED: example.com', url: 'https://example.com/login', code: 'DEMO-5555'};
    const approved = {kind: 'open-url', id: 'approved-1', title: 'APPROVED: github.com', url: 'https://github.com/login/device', code: 'DEMO-6666'};
    await page.route('**/api/v1/workflows/argo/sample-run/log?*', route =>
        route.fulfill({
            contentType: 'text/event-stream',
            body: [rejected, approved]
                .map(event => `data: ${JSON.stringify({result: {content: 'NEEDS_USER_ACTION:' + JSON.stringify(event), podName: 'sample-run-1'}})}\n\n`)
                .join('')
        })
    );

    await page.goto('/workflows/argo?sidePanel=submit-new-workflow&template=sample-job');
    await page.getByRole('button', {name: 'Run job', exact: true}).last().click();

    const dialog = page.getByRole('dialog', {name: 'APPROVED: github.com'});
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('github.com');
    await expect(dialog).not.toContainText('example.com');
    await expect(page.getByText(/marked log line was ignored/)).toBeVisible();
});

test('run action dialog and indicator follow the theme and the indicator can cancel', async ({page}) => {
    await mockApi(page);
    const markedTemplate = {...template, metadata: {...template.metadata, annotations: {...template.metadata.annotations, 'workflows-ui-action-marker': 'NEEDS_USER_ACTION:'}}};
    await page.route('**/api/v1/userinfo', route => route.fulfill({contentType: 'application/json', body: '{}'}));
    await page.route('**/api/v1/extensions/run-action-policy', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({allowedHosts: ['github.com']})}));
    await page.route(/\/api\/v1\/workflow-templates\/argo(?:\?.*)?$/, route => route.fulfill({contentType: 'application/json', body: JSON.stringify({items: [markedTemplate]})}));
    await page.route('**/api/v1/workflows/argo/sample-run', route =>
        route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})})
    );
    await page.route('**/api/v1/workflows/argo/submit', route =>
        route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})})
    );
    await page.route('**/api/v1/workflows/argo/sample-run/log?*', route =>
        route.fulfill({
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify({
                result: {
                    content: 'NEEDS_USER_ACTION:{"kind":"open-url","id":"theme-1","title":"Sign in","url":"https://github.com/login/device","code":"ABCD-1234"}',
                    podName: 'sample-run-1'
                }
            })}\n\n`
        })
    );

    // Switch theme first: the submit panel hides the rest of the app from assistive technology.
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Switch to dark mode'}).click();
    await page.goto('/workflows/argo?sidePanel=submit-new-workflow&template=sample-job');
    await page.getByRole('button', {name: 'Run job', exact: true}).last().click();

    const dialog = page.getByRole('dialog', {name: 'Sign in'});
    await expect(dialog).toBeVisible();
    const background = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(background).toBe('rgb(31, 41, 55)');

    await page.getByRole('button', {name: 'Close run action'}).click();
    await expect(page.getByRole('button', {name: 'Action required (1)'})).toBeVisible();
    await page.getByRole('button', {name: 'Cancel'}).click();
    await expect(page.getByRole('button', {name: 'Action required (1)'})).toHaveCount(0);
});

test('a marked run action appears across pages and opens its link without leaving the run overview', async ({page}) => {
    await mockApi(page);
    const markedTemplate = {...template, metadata: {...template.metadata, annotations: {...template.metadata.annotations, 'workflows-ui-action-marker': 'NEEDS_USER_ACTION:'}}};
    // Client auth has no OIDC subject; monitoring must still start in this tab.
    await page.route('**/api/v1/userinfo', route => route.fulfill({contentType: 'application/json', body: '{}'}));
    await page.route('**/api/v1/extensions/run-action-policy', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({allowedHosts: ['github.com']})}));
    await page.route(/\/api\/v1\/workflow-templates\/argo(?:\?.*)?$/, route => route.fulfill({contentType: 'application/json', body: JSON.stringify({items: [markedTemplate]})}));
    await page.route('**/api/v1/workflows/argo/sample-run', route =>
        route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})})
    );
    let submitOptions: any;
    await page.route('**/api/v1/workflows/argo/submit', route => {
        submitOptions = route.request().postDataJSON().submitOptions;
        return route.fulfill({contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, phase: 'Running', finishedAt: undefined}})});
    });
    await page.route('**/api/v1/workflows/argo/sample-run/log?*', async route => {
        await new Promise(resolve => setTimeout(resolve, 2500));
        const content =
            'NEEDS_USER_ACTION:' + JSON.stringify({kind: 'open-url', id: 'auth-1', title: 'Sign in to continue', url: 'https://github.com/login/device', code: 'ABCD-1234'});
        await route.fulfill({contentType: 'text/event-stream', body: `data: ${JSON.stringify({result: {content, podName: 'sample-run-1'}})}\n\n`});
    });
    await page.goto('/workflows/argo?sidePanel=submit-new-workflow&template=sample-job');
    await page.getByRole('button', {name: 'Run job', exact: true}).last().click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
    expect(submitOptions.annotations).toContain('workflows-ui-action-marker=NEEDS_USER_ACTION:');
    await page.getByRole('button', {name: 'Reports', exact: true}).click();
    await expect(page).toHaveURL(/\/reports/);
    const dialog = page.getByRole('dialog', {name: 'Sign in to continue'});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('ABCD-1234')).toBeVisible();
    await dialog.getByRole('link', {name: /Open github.com/}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run\?tab=summary/);
    await expect(page.getByRole('tab', {name: 'Overview'})).toHaveAttribute('aria-selected', 'true');
    const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
    expect(stored).not.toContain('ABCD-1234');
    await page.reload();
    await expect(page.getByRole('dialog', {name: 'Sign in to continue'})).toBeVisible();
});

test('run details drawer follows the dark theme', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Switch to dark mode'}).click();
    await expect(page.locator('.modern-layout')).toHaveClass(/theme-dark/);

    await page.getByRole('button', {name: 'Show details for sample-run'}).click();
    const drawer = page.locator('.workflow-drawer');
    await expect(drawer).toBeVisible();

    const background = await drawer.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(background).toBe('rgb(31, 41, 55)');
});

test('the submit panel shows parameter descriptions in the dark theme', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo?sidePanel=submit-new-workflow&template=sample-job');
    const description = page.getByText('Text the job prints when it runs.');
    await expect(description).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'message'})).toHaveAttribute('aria-describedby', 'parameter-message-0-description');
});

test('shows the workflows name on a run page', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    await expect(page).toHaveTitle(/ - workflows$/);
    await expect(page.locator('.modern-layout__brand-title')).toHaveText('workflows');
});

test('creating a template requires an explicit type regardless of the list filter', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    await page.getByLabel('Type', {exact: true}).selectOption('cluster');
    const trigger = page.getByRole('button', {name: 'Create job template'});
    await trigger.click();
    const dialog = page.getByRole('dialog', {name: 'create job template'});
    const next = dialog.getByRole('button', {name: 'Continue'});
    await expect(next).toBeDisabled();
    const namespaceChoice = dialog.getByRole('radio', {name: /^Workflow template/});
    const clusterChoice = dialog.getByRole('radio', {name: /^Cluster workflow template/});
    await expect(namespaceChoice).not.toBeChecked();
    await expect(clusterChoice).not.toBeChecked();
    await namespaceChoice.check();
    await expect(next).toBeEnabled();
    await clusterChoice.check();
    await expect(clusterChoice).toBeChecked();
    await expect(namespaceChoice).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByRole('button', {name: 'Continue'})).toBeDisabled();
});

for (const type of ['workflow', 'cluster'] as const) {
    test(`creates a ${type} template through the matching API`, async ({page}) => {
        const submissions = await mockApi(page);
        await page.goto('/workflow-templates/argo');
        await page.getByRole('button', {name: 'Create job template'}).click();
        const dialog = page.getByRole('dialog', {name: 'create job template'});
        await dialog.getByRole('radio', {name: type === 'workflow' ? /^Workflow template/ : /^Cluster workflow template/}).check();
        await dialog.getByRole('button', {name: 'Continue'}).click();
        if (type === 'workflow') {
            await expect(dialog.getByRole('heading', {name: 'Create workflow template'})).toBeFocused();
            await expect(dialog.getByText('Namespace:')).toBeVisible();
        } else {
            await expect(dialog.getByRole('heading', {name: 'Create cluster workflow template'})).toBeFocused();
            await expect(dialog.getByText('Cluster-wide')).toBeVisible();
        }
        await dialog.getByRole('button', {name: /Create$/}).click();
        await expect(page).toHaveURL(type === 'workflow' ? /\/workflow-templates\/argo\/sample-job/ : /\/cluster-workflow-templates\/shared-job/);
        expect(submissions).toHaveLength(1);
        expect(submissions[0]).toMatchObject({template: {metadata: type === 'workflow' ? {namespace: 'argo'} : expect.not.objectContaining({namespace: expect.anything()})}});
    });
}

test('cluster template creation reports permission errors without leaving the editor', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/cluster-workflow-templates', route => {
        if (route.request().method() === 'POST') return route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'Permission denied'})});
        return route.fallback();
    });
    await page.goto('/workflow-templates/argo');
    await page.getByRole('button', {name: 'Create job template'}).click();
    const dialog = page.getByRole('dialog', {name: 'create job template'});
    await dialog.getByRole('radio', {name: /^Cluster workflow template/}).check();
    await dialog.getByRole('button', {name: 'Continue'}).click();
    await dialog.getByRole('button', {name: /Create$/}).click();
    await expect(dialog.getByRole('alert')).toContainText(/Permission denied/);
    await expect(dialog.getByRole('heading', {name: 'Create cluster workflow template'})).toBeVisible();
});

test('schedules filter by resource name or title and preserve the search in the URL', async ({page}) => {
    await mockApi(page);
    const makeSchedule = (name: string, title?: string) => ({
        metadata: {name, namespace: 'argo', creationTimestamp: '2025-01-01T00:00:00Z', annotations: title ? {'workflows.argoproj.io/title': title} : {}},
        spec: {schedules: ['0 * * * *'], timezone: 'UTC', suspend: true}
    });
    await page.route('**/api/v1/cron-workflows/argo*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: [makeSchedule('cleanup-by-name'), makeSchedule('technical-id', 'Daily cleanup'), makeSchedule('unrelated')]})
        })
    );
    await page.goto('/cron-workflows/argo');
    const filter = page.getByRole('combobox', {name: 'Schedule name or title contains'});
    await filter.fill('CLEANUP');
    await expect(page).toHaveURL(/name=CLEANUP/);
    await expect(page.getByRole('link', {name: /cleanup-by-name/})).toBeVisible();
    await expect(page.getByRole('link', {name: /Daily cleanup/})).toBeVisible();
    await expect(page.getByRole('link', {name: /unrelated/})).toHaveCount(0);
    await page.reload();
    await expect(filter).toHaveValue('CLEANUP');
    await expect(page.getByRole('link', {name: /Daily cleanup/})).toBeVisible();
    await filter.fill('no-such-schedule');
    await expect(page.getByText('No matching schedules')).toBeVisible();
    await page.getByRole('button', {name: 'Clear all'}).click();
    await expect(filter).toHaveValue('');
    await expect(page.getByRole('link', {name: /unrelated/})).toBeVisible();
    await expect(page).not.toHaveURL(/name=/);
});

test('jobs expose one name or title filter without a loaded-page search', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    await expect(page.getByRole('combobox', {name: 'Job name or title contains'})).toBeVisible();
    await expect(page.getByLabel('Search loaded jobs by name, description or team')).toHaveCount(0);
});

test('team filter is sent to the server as a label selector', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    const request = page.waitForRequest(
        req => req.url().includes('/workflow-templates/argo?') && new URL(req.url()).searchParams.get('listOptions.labelSelector') === 'team=platform'
    );
    const clusterRequest = page.waitForRequest(
        req => req.url().includes('/cluster-workflow-templates?') && new URL(req.url()).searchParams.get('listOptions.labelSelector') === 'team=platform'
    );
    await page.getByLabel('Job search filter').selectOption('team');
    await page.getByLabel('Filter jobs by team label').fill('platform');
    await Promise.all([request, clusterRequest]);
    await expect(page).toHaveURL(/label=team%3Dplatform/);
});

test('job search modes retain name, team and label filters when switching', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    const mode = page.getByLabel('Job search filter');
    await page.getByRole('combobox', {name: 'Job name or title contains'}).fill('sample');
    await expect(page).toHaveURL(/name=sample/);
    await mode.selectOption('team');
    await page.getByRole('combobox', {name: 'Filter jobs by team label'}).fill('platform');
    await expect(page).toHaveURL(/label=team%3Dplatform/);
    await mode.selectOption('label');
    await page.getByRole('combobox', {name: 'Job label contains'}).fill('PLAT');
    await expect(page).toHaveURL(/labelContains=PLAT/);
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    await mode.selectOption('name');
    await expect(page.getByRole('combobox', {name: 'Job name or title contains'})).toHaveValue('sample');
    await expect(page.getByLabel('Active filters')).toContainText('team=platform');
    await expect(page.getByLabel('Active filters')).toContainText('Label contains: PLAT');
    await page.getByRole('button', {name: 'Clear all'}).click();
    await expect(page).not.toHaveURL(/labelContains|label=|name=/);
});

test('job label contains finds labels on later namespace pages and cluster jobs', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflow-templates/argo?*', route => {
        const params = new URL(route.request().url()).searchParams;
        const scanned = params.get('listOptions.limit') === '200';
        const second = params.get('listOptions.continue') === 'next';
        const item = second ? {...template, metadata: {...template.metadata, name: 'audited-job', labels: {'owner/team': 'Audit'}}} : template;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({metadata: scanned && !second ? {continue: 'next'} : {}, items: [item]})});
    });
    await page.route('**/api/v1/cluster-workflow-templates*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: [{...clusterTemplate, metadata: {...clusterTemplate.metadata, labels: {'audit/group': 'ops'}}}]})
        })
    );
    await page.goto('/workflow-templates/argo');
    await page.getByLabel('Job search filter').selectOption('label');
    await page.getByRole('combobox', {name: 'Job label contains'}).fill('audit');
    await expect(page.getByRole('link', {name: 'Run job audited-job'})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Run cluster job shared-job'})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toHaveCount(0);
});

test('jobs filter shows both template types and preserves existing routes', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    const type = page.getByLabel('Type', {exact: true});
    await expect(type).toHaveValue('both');
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    const clusterJob = page.getByRole('link', {name: 'Run cluster job shared-job'});
    await expect(clusterJob).toBeVisible();
    await expect(clusterJob).toHaveAttribute('href', '/cluster-workflow-templates/shared-job?sidePanel=true&namespace=argo');
    await type.selectOption('workflow');
    await expect(page).toHaveURL(/type=workflow/);
    await expect(clusterJob).toHaveCount(0);
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    await type.selectOption('cluster');
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toHaveCount(0);
    await expect(clusterJob).toBeVisible();
    await page.reload();
    await expect(type).toHaveValue('cluster');
    await type.selectOption('both');
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    await expect(clusterJob).toBeVisible();
});

test('cluster jobs remain available while namespace template pages change', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflow-templates/argo?*', route => {
        const offset = new URL(route.request().url()).searchParams.get('listOptions.continue');
        const item = offset ? {...template, metadata: {...template.metadata, name: 'second-job'}} : template;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({metadata: {continue: offset ? '' : 'next'}, items: [item]})});
    });
    await page.goto('/workflow-templates/argo');
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Run cluster job shared-job'})).toBeVisible();
    await page.getByRole('button', {name: 'Next page'}).click();
    await expect(page.getByRole('link', {name: 'Run job second-job'})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Run cluster job shared-job'})).toBeVisible();
    await expect(page.getByText('Namespace templates are paginated; cluster templates appear on every namespace page.')).toBeVisible();
});

test('cluster listing permission failure leaves namespace jobs usable', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/cluster-workflow-templates*', route => route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'Forbidden'})}));
    await page.goto('/workflow-templates/argo');
    await expect(page.getByText('Could not load cluster templates. You may not have permission to list them.')).toBeVisible();
    await expect(page.getByRole('link', {name: 'Run job sample-job'})).toBeVisible();
    await page.getByLabel('Type', {exact: true}).selectOption('workflow');
    await expect(page.getByText('Could not load cluster templates. You may not have permission to list them.')).toHaveCount(0);
});

test('cluster job submission retains the selected namespace', async ({page}) => {
    const submissions = await mockApi(page);
    await page.goto('/workflow-templates/argo');
    await page.getByRole('link', {name: 'Run cluster job shared-job'}).click();
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    await expect(dialog.getByLabel('Namespace')).toHaveValue('argo');
    await page.reload();
    await expect(dialog.getByLabel('Namespace')).toHaveValue('argo');
    await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
    expect(submissions[0]).toMatchObject({namespace: 'argo', resourceKind: 'ClusterWorkflowTemplate', resourceName: 'shared-job'});
});

test('catalog submission uses an isolated API and navigates to the run', async ({page}) => {
    const submissions = await mockApi(page);
    await page.goto('/workflow-templates/argo');
    await page.getByRole('link', {name: 'Run job sample-job'}).click();
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', {name: 'Run job'})).toBeVisible();
    await dialog.getByRole('textbox', {name: 'message'}).fill('hello');
    await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({namespace: 'argo', resourceKind: 'WorkflowTemplate', resourceName: 'sample-job', submitOptions: {parameters: ['message=hello']}});
});

test('failure preserves inputs and allows retry', async ({page}) => {
    const submissions = await mockApi(page, true);
    await page.goto('/workflow-templates/argo/sample-job?sidePanel=submit');
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    const input = dialog.getByRole('textbox', {name: 'message'});
    await input.fill('retry value');
    await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
    await expect(dialog.getByRole('alert')).toContainText(/Submission failed/);
    await expect(input).toHaveValue('retry value');
    await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
    expect(submissions).toHaveLength(2);
});

for (const [scope, name, kind] of [
    ['namespace', 'sample-job', 'WorkflowTemplate'],
    ['cluster', 'shared-job', 'ClusterWorkflowTemplate']
] as const) {
    test(`run creation supports a ${scope} template`, async ({page}) => {
        const submissions = await mockApi(page);
        await page.goto('/workflows/argo');
        await page.getByRole('button', {name: 'Run job'}).click();
        const dialog = page.getByRole('dialog', {name: 'run job panel'});
        await dialog.getByLabel('Job', {exact: true}).fill(name);
        await dialog.getByRole('option', {name: `${name} (${scope})`}).click();
        await expect(dialog.getByRole('heading', {name: `argo/${name}`})).toBeVisible();
        await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
        await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
        expect(submissions[0]).toMatchObject({namespace: 'argo', resourceKind: kind, resourceName: name});
    });
}

test('namespace filter accepts typed names without namespace discovery', async ({page}) => {
    await mockApi(page);
    let discoveryRequests = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname.includes('/namespaces')) discoveryRequests++;
    });
    await page.goto('/workflows/argo');
    await expect(page.getByText('Suggestions come from loaded results and recently entered namespaces.')).toBeVisible();
    const namespace = page.getByRole('combobox', {name: 'Run namespace'});
    await namespace.fill('another-team');
    await namespace.press('Enter');
    await expect(page).toHaveURL(/workflows\/another-team/);
    expect(discoveryRequests).toBe(0);
});

test('run name and label search modes retain applied filters', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    await page.getByRole('combobox', {name: 'Run name or title contains'}).fill('sample');
    await expect(page).toHaveURL(/Contains=sample/);
    await page.getByLabel('Run search filter').selectOption('label');
    await page.getByRole('combobox', {name: 'Run label contains'}).fill('plat');
    await expect(page).toHaveURL(/labelContains=plat/);
    await expect(page.getByRole('rowheader').filter({hasText: 'sample-run'})).toBeVisible();
    await page.getByLabel('Run search filter').selectOption('name');
    await expect(page.getByRole('combobox', {name: 'Run name or title contains'})).toHaveValue('sample');
    await expect(page.getByLabel('Active filters')).toContainText('Label contains: plat');
});

test('run label contains searches label keys and values across server pages', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo?*', route => {
        const params = new URL(route.request().url()).searchParams;
        const scanned = params.get('listOptions.limit') === '200';
        const second = params.get('listOptions.continue') === 'next';
        const item = second
            ? {...workflow, metadata: {...workflow.metadata, name: 'audit-run', uid: 'second', labels: {'group/owner': 'AuditTeam'}}}
            : {...workflow, metadata: {...workflow.metadata, name: 'other-run', uid: 'first', labels: {team: 'platform'}}};
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({metadata: {resourceVersion: '1', ...(scanned && !second ? {continue: 'next'} : {})}, items: [item]})
        });
    });
    await page.goto('/workflows/argo');
    await page.getByLabel('Run search filter').selectOption('label');
    await page.getByRole('combobox', {name: 'Run label contains'}).fill('audit');
    await expect(page.getByRole('rowheader').filter({hasText: 'audit-run'})).toBeVisible();
    await expect(page.getByRole('rowheader').filter({hasText: 'other-run'})).toHaveCount(0);
});

test('run name filter finds title matches on later server pages', async ({page}) => {
    await mockApi(page);
    let scannedSecondPage = false;
    await page.route('**/api/v1/workflows/argo?*', route => {
        const params = new URL(route.request().url()).searchParams;
        const scanned = params.get('listOptions.limit') === '200';
        const second = params.get('listOptions.continue') === 'next';
        if (scanned && second) scannedSecondPage = true;
        const item = second
            ? {...workflow, metadata: {...workflow.metadata, name: 'technical-id', uid: 'second', annotations: {'workflows.argoproj.io/title': 'Daily cleanup'}}}
            : {...workflow, metadata: {...workflow.metadata, name: 'cleanup-by-name', uid: 'first'}};
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({metadata: {resourceVersion: '1', ...(scanned && !second ? {continue: 'next'} : {})}, items: [item]})
        });
    });
    await page.goto('/workflows/argo');
    await page.getByRole('combobox', {name: 'Run name or title contains'}).fill('cleanup');
    await expect(page.getByRole('rowheader').filter({hasText: 'Daily cleanup'})).toBeVisible();
    await expect(page.getByRole('rowheader').filter({hasText: 'cleanup-by-name'})).toBeVisible();
    expect(scannedSecondPage).toBe(true);
});

test('title search paginates matches across scanned run pages', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo?*', route => {
        const params = new URL(route.request().url()).searchParams;
        const scanned = params.get('listOptions.limit') === '200';
        const second = params.get('listOptions.continue') === 'next';
        const start = second ? 4 : 1;
        const items = Array.from({length: 3}, (_, index) => ({
            ...workflow,
            metadata: {
                ...workflow.metadata,
                name: `technical-${start + index}`,
                uid: `uid-${start + index}`,
                annotations: {'workflows.argoproj.io/title': `Cleanup ${start + index}`}
            }
        }));
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({metadata: {resourceVersion: '1', ...(scanned && !second ? {continue: 'next'} : {})}, items})
        });
    });
    await page.goto('/workflows/argo?limit=5');
    await page.getByRole('combobox', {name: 'Run name or title contains'}).fill('cleanup');
    await expect(page.getByRole('rowheader')).toHaveCount(5);
    await page.getByRole('button', {name: 'Next page'}).click();
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await expect(page.getByRole('button', {name: 'First page'})).toBeEnabled();
});

test('job name filter finds namespace and cluster title matches', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflow-templates/argo?*', route => {
        const params = new URL(route.request().url()).searchParams;
        const scanned = params.get('listOptions.limit') === '200';
        const second = params.get('listOptions.continue') === 'next';
        const item = second ? {...template, metadata: {...template.metadata, name: 'technical-id', annotations: {'workflows.argoproj.io/title': 'Daily cleanup'}}} : template;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({metadata: scanned && !second ? {continue: 'next'} : {}, items: [item]})});
    });
    await page.route('**/api/v1/cluster-workflow-templates*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: [{...clusterTemplate, metadata: {...clusterTemplate.metadata, annotations: {'workflows.argoproj.io/title': 'Shared cleanup'}}}]})
        })
    );
    await page.goto('/workflow-templates/argo');
    await page.getByRole('combobox', {name: 'Job name or title contains'}).fill('cleanup');
    await expect(page.getByText('Daily cleanup', {exact: true})).toBeVisible();
    await expect(page.getByText('Shared cleanup', {exact: true})).toBeVisible();
});

test('job search accepts only an available option by keyboard', async ({page}) => {
    const submissions = await mockApi(page);
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Run job'}).click();
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    const job = dialog.getByRole('combobox', {name: 'Job'});
    await job.fill('not-a-job');
    await expect(dialog.getByText('No matching loaded options')).toBeVisible();
    await job.press('Enter');
    await expect(dialog.getByRole('heading', {name: 'Run a job'})).toBeVisible();
    expect(submissions).toHaveLength(0);
    await job.fill('shared-job');
    await job.press('ArrowDown');
    await job.press('Enter');
    await expect(dialog.getByRole('heading', {name: 'argo/shared-job'})).toBeVisible();
});

test('run creation distinguishes identical template names across scopes', async ({page}) => {
    const submissions = await mockApi(page);
    await page.route('**/api/v1/cluster-workflow-templates', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: [{...clusterTemplate, metadata: {...clusterTemplate.metadata, name: 'sample-job'}}]})
        })
    );
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Run job'}).click();
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    await dialog.getByLabel('Job', {exact: true}).fill('sample-job');
    await expect(dialog.getByRole('option', {name: 'sample-job (namespace)'})).toHaveCount(1);
    await expect(dialog.getByRole('option', {name: 'sample-job (cluster)'})).toHaveCount(1);
    await dialog.getByRole('option', {name: 'sample-job (cluster)'}).click();
    await dialog.getByRole('button', {name: 'Run job', exact: true}).click();
    await expect(page).toHaveURL(/\/workflows\/argo\/sample-run/);
    expect(submissions[0]).toMatchObject({resourceKind: 'ClusterWorkflowTemplate', resourceName: 'sample-job'});
});

test('cluster templates do not offer namespace-only artifact uploads', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/cluster-workflow-templates', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: [{...clusterTemplate, spec: {...clusterTemplate.spec, arguments: {...clusterTemplate.spec.arguments, artifacts: [{name: 'input'}]}}}]})
        })
    );
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Run job'}).click();
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    await dialog.getByLabel('Job', {exact: true}).fill('shared-job');
    await dialog.getByRole('option', {name: 'shared-job (cluster)'}).click();
    await expect(dialog.getByText(/File uploads are not available for cluster workflow templates/)).toBeVisible();
    await expect(dialog.getByText('Input Artifacts', {exact: true})).toHaveCount(0);
});

test('cluster template deep links keep the requested template scope', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo?sidePanel=submit-new-workflow&template=shared-job&templateKind=ClusterWorkflowTemplate');
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    await expect(dialog.getByRole('heading', {name: 'argo/shared-job'})).toBeVisible();
    await expect(page).toHaveURL(/templateKind=ClusterWorkflowTemplate/);
    await expect(dialog.getByText('Template type: Cluster workflow template')).toBeVisible();
});

test('namespace templates remain usable if cluster template listing is denied', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/cluster-workflow-templates*', route => route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'Forbidden'})}));
    await page.goto('/workflows/argo');
    await page.getByRole('button', {name: 'Run job'}).click();
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    await expect(dialog.getByText('Could not load cluster templates.')).toBeVisible();
    await dialog.getByLabel('Job', {exact: true}).fill('sample-job');
    await dialog.getByRole('option', {name: 'sample-job (namespace)'}).click();
    await expect(dialog.getByRole('heading', {name: 'argo/sample-job'})).toBeVisible();
});

test('submission dialog provides keyboard focus, dismissal, and restoration', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    const trigger = page.getByRole('button', {name: 'Run job'});
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', {name: 'run job panel'});
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('navigation', {name: 'Primary navigation'})).toHaveCount(0);
    const close = dialog.getByRole('button', {name: 'Close run job panel'});
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog).toContainText('Use the full workflow editor');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('navigation', {name: 'Primary navigation'})).toBeVisible();
    await expect(trigger).toBeFocused();
});

test('overview places parameters before workflow details', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo/sample-run');
    const panel = page.getByRole('tabpanel', {name: 'Overview'});
    const from = panel.getByText('From', {exact: true});
    const parameters = panel.getByRole('region', {name: 'Parameters'});
    const details = panel.getByRole('region', {name: 'Workflow Details'});
    const outputs = panel.getByRole('region', {name: 'Outputs and artifacts'});
    await expect(from).toBeVisible();
    await expect(panel.getByText('Message', {exact: true})).toHaveCount(0);
    await expect(parameters).toContainText('message');
    await expect(details.getByText('Labels', {exact: true})).toBeHidden();
    const parameterBounds = await parameters.boundingBox();
    const collapsedDetailsBounds = await details.boundingBox();
    const collapsedOutputsBounds = await outputs.boundingBox();
    expect(collapsedDetailsBounds!.y - (parameterBounds!.y + parameterBounds!.height)).toBeGreaterThanOrEqual(20);
    expect(collapsedOutputsBounds!.y - (collapsedDetailsBounds!.y + collapsedDetailsBounds!.height)).toBeGreaterThanOrEqual(20);
    await details.locator('summary').first().click();
    await expect(details.getByText('Labels', {exact: true})).toBeVisible();
    const expandedDetailsBounds = await details.boundingBox();
    const expandedOutputsBounds = await outputs.boundingBox();
    expect(expandedOutputsBounds!.y - (expandedDetailsBounds!.y + expandedDetailsBounds!.height)).toBeGreaterThanOrEqual(20);
    await expect(details).toContainText('Labels');
    await expect(details).toContainText('Conditions');
    await expect(panel.getByText('Started', {exact: true})).toBeVisible();
    expect(
        await from.evaluate(
            (element, parameterId) => !!(element.compareDocumentPosition(document.getElementById(parameterId)!) & Node.DOCUMENT_POSITION_FOLLOWING),
            'workflow-parameters-heading'
        )
    ).toBe(true);
    expect(
        await parameters.evaluate(
            (element, detailsId) => !!(element.compareDocumentPosition(document.getElementById(detailsId)!) & Node.DOCUMENT_POSITION_FOLLOWING),
            'workflow-details-heading'
        )
    ).toBe(true);
});

test('overview truncates multiline parameters and reveals each full value on demand', async ({page}) => {
    await mockApi(page);
    const multiline = {
        ...workflow,
        spec: {
            ...workflow.spec,
            arguments: {
                parameters: [
                    {name: 'message', value: 'first line\nsecond line'},
                    {name: 'config', value: 'another line\nmore config'}
                ]
            }
        }
    };
    await page.route('**/api/v1/workflows/argo/sample-run', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(multiline)}));
    await page.goto('/workflows/argo/sample-run');
    const parameters = page.getByRole('region', {name: 'Parameters'});
    const message = parameters.locator('.white-box__details-row').filter({hasText: 'message'});
    const config = parameters.locator('.white-box__details-row').filter({hasText: 'config'});
    const preview = message.locator('.workflow-parameter-value__preview');
    await expect(preview).toHaveText('first line…');
    expect(await preview.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');
    expect(await preview.evaluate(element => getComputedStyle(element).textOverflow)).toBe('ellipsis');
    await expect(message.locator('pre')).toBeHidden();
    await message.getByText('View full value').click();
    await expect(message.locator('pre')).toBeVisible();
    await expect(message.locator('pre')).toHaveText('first line\nsecond line');
    await expect(config.locator('pre')).toBeHidden();
    await message.getByText('Hide full value').click();
    await expect(message.locator('pre')).toBeHidden();
});

test('overview displays a non-empty workflow status message', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo/sample-run*', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({...workflow, status: {...workflow.status, message: 'Example status message'}})})
    );
    await page.goto('/workflows/argo/sample-run');
    const panel = page.getByRole('tabpanel', {name: 'Overview'});
    await expect(panel.getByText('Message', {exact: true})).toBeVisible();
    await expect(panel.getByText('Example status message')).toBeVisible();
});

test('reports load completed runs on entry and template filters match the request', async ({page}) => {
    await mockApi(page);
    const firstRequest = page.waitForRequest(req => req.url().includes('/api/v1/workflows/argo?') && !new URL(req.url()).searchParams.has('listOptions.labelSelector'));
    await page.goto('/reports/argo');
    await firstRequest;
    await expect(page.getByRole('img', {name: 'Workflow duration chart for 2 workflows'})).toBeVisible();
    const templateSelect = page.getByRole('combobox', {name: 'Report job (namespace template)'});
    const cronSelect = page.getByRole('combobox', {name: 'Report schedule'});
    await expect(templateSelect).toHaveValue('');
    await expect(cronSelect).toHaveValue('');
    const filteredRequest = page.waitForRequest(req => new URL(req.url()).searchParams.get('listOptions.labelSelector') === 'workflows.argoproj.io/workflow-template=sample-job');
    await templateSelect.fill('sample-job');
    await page.getByRole('option', {name: 'sample-job', exact: true}).click();
    await filteredRequest;
    await expect(page).toHaveURL(/workflow-template%3Dsample-job/);
    await page.getByRole('button', {name: 'Clear Report job (namespace template)'}).click();
    await expect(templateSelect).toHaveValue('');
    await expect(page).not.toHaveURL(/workflow-template%3Dsample-job/);
});

test('reports distinguish an empty result from a request failure', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo?*', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({metadata: {resourceVersion: '1'}, items: []})})
    );
    await page.goto('/reports/argo');
    await expect(page.getByText('No completed runs', {exact: true})).toBeVisible();
    await page.unroute('**/api/v1/workflows/argo?*');
    await page.route('**/api/v1/workflows/argo?*', route => route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'Report access denied'})}));
    await page.reload();
    await expect(page.getByRole('alert').first()).toContainText(/Report access denied/);
    await expect(page.getByText('No completed runs', {exact: true})).toHaveCount(0);
});

test('report deep links show their selected filters', async ({page}) => {
    await mockApi(page);
    await page.goto('/reports/argo?labels=workflows.argoproj.io%2Fworkflow-template%3Dsample-job');
    await expect(page.getByRole('combobox', {name: 'Report job (namespace template)'})).toHaveValue('sample-job');
    await expect(page.getByRole('img', {name: 'Workflow duration chart for 2 workflows'})).toBeVisible();
});

test('run tabs expose their panel and support keyboard navigation', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo/sample-run');
    const overview = page.getByRole('tab', {name: 'Overview'});
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', {name: 'Overview'})).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText(['Overview', 'Graph', 'Events', 'Timeline']);
    await overview.focus();
    await page.keyboard.press('ArrowRight');
    const graph = page.getByRole('tab', {name: 'Graph'});
    await expect(graph).toBeFocused();
    await expect(graph).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', {name: 'Graph'})).toBeVisible();
    const node = page.getByRole('button', {name: 'sample-run node, Succeeded'});
    await expect(node).toBeVisible();
    await node.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: 'Close step details'})).toBeVisible();
});

test('all results selection persists and exposes loaded-result sorting', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    const size = page.getByLabel('Results per page');
    await size.selectOption('0');
    await expect(page).toHaveURL(/limit=0/);
    await expect(page.getByLabel('Sort by')).toHaveAccessibleDescription('Sorts all loaded results');
    await page.reload();
    await expect(size).toHaveValue('0');
    await expect(page.getByLabel('Sort by')).toHaveAccessibleDescription('Sorts all loaded results');
});

test('sorting controls remain visible beside the collapsed and expanded navigation', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('argo-ui-navigation-expanded', 'false'));
    await page.goto('/workflows/argo?limit=100');
    const nav = page.getByRole('navigation', {name: 'Primary navigation'});
    const label = page.locator('label[for="runs-sort"]');
    const sort = page.getByLabel('Sort by');
    await expect(sort).toBeVisible();
    await expect(sort).toHaveValue('started:descending');
    for (const expand of [false, true]) {
        if (expand) {
            await page.getByRole('button', {name: 'Expand navigation'}).click();
            await expect(page.locator('.modern-layout')).toHaveClass(/modern-layout--expanded/);
            await page.waitForTimeout(250);
        }
        const navBounds = await nav.boundingBox();
        const labelBounds = await label.boundingBox();
        expect(labelBounds!.x).toBeGreaterThanOrEqual(navBounds!.x + navBounds!.width);
    }
});

for (const [route, filterSelector, tableSelector] of [
    ['/workflows/argo', '.wf-filters-container', '.workflows-table'],
    ['/workflow-templates/argo', '.filter-bar', '.filter-bar__results > .argo-table-list'],
    ['/cron-workflows/argo', '.filter-bar', '.filter-bar__results > .argo-table-list'],
    ['/reports/argo', '.filter-bar', '.reports-chart-card--duration']
] as const) {
    test(`filters and results align on ${route}`, async ({page}) => {
        await mockApi(page);
        await page.addInitScript(() => localStorage.setItem('argo-ui-navigation-expanded', 'false'));
        for (const {width, expanded} of [
            {width: 1440, expanded: false},
            {width: 1440, expanded: true},
            {width: 390, expanded: false}
        ]) {
            await page.setViewportSize({width, height: 900});
            await page.goto(route);
            if (expanded) {
                await page.getByRole('button', {name: 'Expand navigation'}).click();
                await expect(page.locator('.modern-layout')).toHaveClass(/modern-layout--expanded/);
                await page.waitForTimeout(250);
            }
            const filter = page.locator(filterSelector);
            const table = page.locator(tableSelector);
            await expect(filter).toBeVisible();
            await expect(table).toBeVisible();
            const filterBounds = await filter.boundingBox();
            const tableBounds = await table.boundingBox();
            expect(Math.abs(filterBounds!.x - tableBounds!.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(filterBounds!.width - tableBounds!.width)).toBeLessThanOrEqual(1);
        }
    });
}

test('sorting controls remain usable on narrow screens', async ({page}) => {
    await mockApi(page);
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/workflows/argo?limit=100');
    const sort = page.getByLabel('Sort by');
    await expect(sort).toBeVisible();
    const bounds = await sort.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await sort.selectOption('name:descending');
    await expect(sort).toHaveValue('name:descending');
});

test('sorts the loaded page and persists visible columns', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    const table = page.getByRole('table', {name: 'Runs'});
    await expect(table.getByRole('rowheader')).toHaveCount(2);
    await expect(page.getByLabel('Sort by')).toHaveAccessibleDescription('Sorts this page only');
    await page.getByLabel('Sort by').selectOption('name:ascending');
    await expect(table.getByRole('rowheader').first()).toContainText('alpha-run');
    await page.getByText('Choose columns').click();
    await page.getByLabel('message', {exact: true}).uncheck();
    await expect(table.getByRole('columnheader', {name: 'MESSAGE'})).toHaveCount(0);
    await page.reload();
    await expect(table.getByRole('columnheader', {name: 'MESSAGE'})).toHaveCount(0);
});

const contrast = async (selector: import('@playwright/test').Locator) =>
    selector.evaluate(element => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const luminance = (values: number[]) => {
            const colors = values.slice(0, 3).map(value => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
            });
            return colors[0] * 0.2126 + colors[1] * 0.7152 + colors[2] * 0.0722;
        };
        const foreground = luminance(rgb(getComputedStyle(element).color));
        let parent: Element | null = element;
        let background = [255, 255, 255, 1];
        while (parent) {
            const color = rgb(getComputedStyle(parent).backgroundColor);
            if (color.length >= 3 && (color.length < 4 || color[3] === 1)) {
                background = color;
                break;
            }
            parent = parent.parentElement;
        }
        const bg = luminance(background);
        return (Math.max(foreground, bg) + 0.05) / (Math.min(foreground, bg) + 0.05);
    });

for (const theme of ['light', 'dark'] as const) {
    test(`${theme}-theme schedule expressions are transparent and readable`, async ({page}) => {
        await mockApi(page);
        await page.addInitScript(value => localStorage.setItem('argo-ui-theme', value), theme);
        await page.goto('/cron-workflows/argo');
        const expression = page.locator('.cron-workflow-schedules code').filter({hasText: '0 * * * *'});
        await expect(expression).toBeVisible();
        expect(await expression.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
        expect(await contrast(expression)).toBeGreaterThanOrEqual(4.5);
    });
}

test('light-theme key controls meet text contrast and label filters are keyboard operable', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('argo-ui-theme', 'light'));
    await page.goto('/workflow-templates/argo');
    const link = page.getByRole('link', {name: 'Run job sample-job'});
    await expect(link).toBeVisible();
    expect(await contrast(link)).toBeGreaterThanOrEqual(4.5);
    await page.goto('/workflows/argo/sample-run');
    const label = page.getByRole('button', {name: 'List workflows labelled with team=platform'});
    await expect(label).toBeHidden();
    await page.getByRole('region', {name: 'Workflow Details'}).locator('summary').first().click();
    await page.getByText('View labels (1)').click();
    await expect(label).toBeVisible();
    expect(await contrast(label.locator('.key'))).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(label.locator('.value'))).toBeGreaterThanOrEqual(4.5);
    await label.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/label=team/);
});

test('dark-theme submission controls meet text contrast', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('argo-ui-theme', 'dark'));
    await page.goto('/workflow-templates/argo/sample-job?sidePanel=submit');
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    const button = dialog.getByRole('button', {name: 'Run job', exact: true});
    await expect(button).toBeVisible();
    expect(await contrast(button)).toBeGreaterThanOrEqual(4.5);
    const label = dialog.getByText('message', {exact: true});
    expect(await contrast(label)).toBeGreaterThanOrEqual(4.5);
});

test('theme switch is in the navigation footer in collapsed and expanded layouts', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => {
        localStorage.setItem('argo-ui-navigation-expanded', 'false');
        localStorage.setItem('argo-ui-theme', 'light');
    });
    await page.goto('/workflows/argo');
    const nav = page.getByRole('navigation', {name: 'Primary navigation'});
    const toggle = nav.getByRole('button', {name: 'Switch to dark mode'});
    await expect(toggle).toBeVisible();
    await expect(nav.locator('.modern-layout__footer')).toContainText('Light mode');
    const toggleBounds = await toggle.boundingBox();
    const navBounds = await nav.boundingBox();
    expect(toggleBounds!.x).toBeGreaterThanOrEqual(navBounds!.x);
    expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(navBounds!.x + navBounds!.width);
    await toggle.click();
    await expect(nav.getByRole('button', {name: 'Switch to light mode'})).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', {name: 'Expand navigation'}).click();
    await expect(nav.getByText('Dark mode', {exact: true})).toBeVisible();
});

test('theme switch remains accessible inside mobile navigation', async ({page}) => {
    await mockApi(page);
    await page.setViewportSize({width: 390, height: 844});
    await page.addInitScript(() => localStorage.setItem('argo-ui-theme', 'light'));
    await page.goto('/workflows/argo');
    await expect(page.getByRole('button', {name: 'Switch to dark mode'})).toHaveCount(0);
    await page.getByRole('button', {name: 'Open navigation'}).click();
    const toggle = page.getByRole('navigation', {name: 'Primary navigation'}).getByRole('button', {name: 'Switch to dark mode'});
    await expect(toggle).toBeVisible();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: 'Switch to light mode'})).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', {name: 'Open navigation'})).toBeFocused();
});

test('collapsed navigation centers icons within each item', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('argo-ui-navigation-expanded', 'false'));
    await page.goto('/workflows/argo');
    const items = page.locator('.modern-layout__item');
    await expect(items.first()).toBeVisible();
    const offsets = await items.evaluateAll(elements =>
        elements.map(element => {
            const icon = element.querySelector('i:not(.modern-layout__item-chevron)')!;
            const bounds = element.getBoundingClientRect();
            const iconBounds = icon.getBoundingClientRect();
            return Math.abs(bounds.left + bounds.width / 2 - iconBounds.left - iconBounds.width / 2);
        })
    );
    expect(offsets.every(offset => offset < 1)).toBe(true);
    await page.getByRole('button', {name: 'Expand navigation'}).click();
    await expect(page.getByRole('button', {name: 'Jobs', exact: true}).locator('span')).toBeVisible();
});

test('job launch remains usable at a narrow viewport', async ({page}) => {
    await mockApi(page);
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/workflow-templates/argo/sample-job?sidePanel=submit');
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    await expect(dialog.getByRole('button', {name: 'Run job', exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const path of ['/event-flow/argo', '/event-sources/argo', '/sensors/argo', '/workflow-event-bindings/argo']) {
    test(`namespace suggestion hint aligns with its input on ${path}`, async ({page}) => {
        await page.route('**/api/**', route => {
            const pathname = new URL(route.request().url()).pathname;
            let body: unknown = {};
            if (pathname.endsWith('/info')) body = {managedNamespace: '', columns: [], links: [], modals: {}};
            else if (pathname.endsWith('/userinfo')) body = {subject: 'test-user', serviceAccountNamespace: 'argo'};
            else if (pathname.endsWith('/version')) body = {version: 'test'};
            else if (pathname.includes('/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
            else if (/event-sources|sensors|workflow-event-bindings|workflows/.test(pathname)) body = {metadata: {resourceVersion: '1'}, items: []};
            return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
        });
        await page.goto(path);
        const hint = page.getByText('Suggestions come from loaded results and recently entered namespaces.');
        await expect(hint).toBeVisible();
        const input = page.getByRole('combobox', {name: /namespace/i}).first();
        const hintBox = await hint.boundingBox();
        const inputBox = await input.boundingBox();
        expect(hintBox!.x).toBeGreaterThanOrEqual(inputBox!.x - 1);
        expect(hintBox!.x).toBeLessThan(inputBox!.x + 20);
        const lineHeight = await hint.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
        expect(lineHeight).toBeLessThanOrEqual(18);
        const zeroState = page.locator('.events-zero-state');
        await expect(zeroState).toBeVisible();
        const zeroBox = await zeroState.boundingBox();
        const toolbarBox = await page.locator('.top-bar').last().boundingBox();
        expect(zeroBox!.y - (toolbarBox!.y + toolbarBox!.height)).toBeGreaterThanOrEqual(30);
    });
}

test('schedules use the shared search modes for name, team and label', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/cron-workflows/argo*', route => {
        const labels = new URL(route.request().url()).searchParams.get('listOptions.labelSelector') || '';
        const items = [
            {
                metadata: {name: 'daily', namespace: 'argo', labels: {team: 'platform'}, annotations: {'workflows.argoproj.io/title': 'Daily cleanup'}},
                spec: {schedules: ['0 * * * *']}
            },
            {metadata: {name: 'audit', namespace: 'argo', labels: {'owner/team': 'Audit'}}, spec: {schedules: ['0 * * * *']}},
            {metadata: {name: 'other', namespace: 'argo', labels: {}}, spec: {schedules: ['0 * * * *']}}
        ];
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({items: labels.includes('team=platform') ? [items[0]] : items})
        });
    });
    await page.goto('/cron-workflows/argo');
    const mode = page.getByLabel('Schedule search filter');
    await page.getByRole('combobox', {name: 'Schedule name or title contains'}).fill('daily');
    await expect(page.getByRole('link', {name: /Daily cleanup/})).toBeVisible();
    await expect(page.getByRole('link', {name: /other/})).toHaveCount(0);
    await mode.selectOption('team');
    await page.getByRole('combobox', {name: 'Filter schedules by team label'}).fill('platform');
    await expect(page.getByRole('link', {name: /Daily cleanup/})).toBeVisible();
    await expect(page.getByRole('link', {name: /audit/})).toHaveCount(0);
    await mode.selectOption('label');
    await page.getByRole('combobox', {name: 'Schedule label contains'}).fill('audit');
    await expect(page).toHaveURL(/labelContains=audit/);
});

test('job rows show type and team as compact chips', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo');
    await expect(page.getByRole('columnheader', {name: 'NAME AND TYPE'})).toBeVisible();
    await expect(page.getByRole('columnheader', {name: 'TYPE', exact: true})).toHaveCount(0);
    const row = page.getByRole('rowheader', {name: /sample-job/});
    await expect(row.getByText('Namespace', {exact: true})).toBeVisible();
    await expect(page.getByRole('cell', {name: 'argo platform'})).toBeVisible();
});

test('narrow screens hide secondary run filters until requested', async ({page}) => {
    await mockApi(page);
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/workflows/argo');
    await expect(page.getByLabel('Archive state')).toBeHidden();
    await page.getByRole('button', {name: /More filters/}).click();
    await expect(page.getByLabel('Archive state')).toBeVisible();
});

test('run details explain when there are no outputs', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo/sample-run');
    await expect(page.getByText('This run produced no outputs or artifacts.')).toBeVisible();
});

test('timestamp format control is a labelled keyboard button', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    const toggle = page.getByRole('button', {name: 'Show ISO time'}).first();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(page.getByRole('button', {name: 'Show relative time'}).first()).toHaveAttribute('aria-pressed', 'true');
});

for (const [path, create] of [
    ['/cron-workflows/argo', 'Create New Cron Workflow'],
    ['/event-sources/argo', 'Create New EventSource'],
    ['/sensors/argo', 'Create New Sensor']
] as const) {
    test(`create panel close button dismisses ${path} from its centre`, async ({page}) => {
        await mockApi(page);
        await page.setViewportSize({width: 1440, height: 900});
        await page.goto(path);
        await page.getByRole('button', {name: new RegExp(create, 'i')}).click();
        const close = page.locator('.sliding-panel__close');
        await expect(close).toBeVisible();
        await page.waitForTimeout(700);
        const box = await close.boundingBox();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await expect(page.locator('.sliding-panel--opened')).toHaveCount(0);
    });
}

test('collapsed navigation leaves space before page content', async ({page}) => {
    await mockApi(page);
    await page.addInitScript(() => localStorage.setItem('argo-ui-navigation-expanded', 'false'));
    await page.goto('/workflows/argo');
    const nav = page.getByRole('navigation', {name: 'Primary navigation'});
    const padding = await page
        .locator('.page')
        .first()
        .evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
    const navBox = await nav.boundingBox();
    expect(padding).toBeGreaterThanOrEqual(navBox!.width);
    const topBarLeft = await page
        .locator('.page__top-bar')
        .first()
        .evaluate(element => parseFloat(getComputedStyle(element).left));
    expect(topBarLeft).toBeGreaterThanOrEqual(navBox!.width);
});

test('error notices summarize, disclose details and offer retry', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo?*', route => route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'Report access denied'})}));
    await page.goto('/reports/argo');
    const alert = page.getByRole('alert').first();
    await expect(alert).toContainText('Report access denied');
    await expect(page.getByText('Technical details', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: /Retry/}).first()).toBeVisible();
});

test('reports offer an all-phases choice and show workflow titles', async ({page}) => {
    await mockApi(page);
    await page.route('**/api/v1/workflows/argo?*', route =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                metadata: {resourceVersion: '1'},
                items: [
                    {
                        ...workflow,
                        metadata: {...workflow.metadata, annotations: {'workflows.argoproj.io/title': 'Nightly database backup'}}
                    }
                ]
            })
        })
    );
    await page.goto('/reports/argo');
    await page.getByText('View report data').first().click();
    await expect(page.getByRole('link', {name: 'Nightly database backup'})).toHaveAttribute('title', 'sample-run');
    await expect(page.getByLabel('All phases')).toBeVisible();
});

test('events pages place the namespace filter in the page content', async ({page}) => {
    await mockApi(page);
    await page.goto('/event-sources/argo');
    const filters = page.locator('.events-page__filters');
    await expect(filters.getByRole('combobox', {name: 'Event source namespace'})).toBeVisible();
    await expect(filters.getByText('Namespace', {exact: true})).toBeVisible();
});

test('paused live updates use neutral wording', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo/sample-run');
    await expect(page.getByText('Live updates paused', {exact: true})).toBeVisible();
    await expect(page.getByText('Reconnecting', {exact: true})).toHaveCount(0);
});

test('duplicate top-right page title is removed', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflows/argo');
    await expect(page.getByText('RUNS', {exact: true})).toHaveCount(0);
    await expect(page.getByText('Runs', {exact: true}).first()).toBeVisible();
});

test('ConfigMap-backed parameters load options in the job submission panel', async ({page}) => {
    await mockApi(page);
    const parameterTemplate = {
        ...template,
        metadata: {
            ...template.metadata,
            annotations: {
                ...template.metadata.annotations,
                'workflows.argoproj.io/parameter-sources': JSON.stringify({
                    environment: {configMap: {name: 'catalog', key: 'environments'}, itemsPath: 'items', labelPath: 'name', valuePath: 'id'}
                })
            }
        },
        spec: {...template.spec, arguments: {parameters: [{name: 'environment'}]}}
    };
    await page.route('**/api/v1/workflow-templates/argo?*', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({metadata: {resourceVersion: '1'}, items: [parameterTemplate]})})
    );
    await page.route('**/api/v1/workflow-templates/argo/sample-job*', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(parameterTemplate)})
    );
    const optionsRequest = page.waitForRequest(
        request =>
            request.url().includes('/api/v1/extensions/parameter-options') &&
            new URL(request.url()).searchParams.get('configMapName') === 'catalog' &&
            new URL(request.url()).searchParams.get('configMapKey') === 'environments' &&
            new URL(request.url()).searchParams.get('namespace') === 'argo'
    );
    await page.route('**/api/v1/extensions/parameter-options?*', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({items: [{label: 'Staging', value: 'staging'}]})})
    );
    await page.goto('/workflow-templates/argo');
    await page.getByRole('link', {name: /Run job sample-job/}).click();
    const dialog = page.getByRole('dialog', {name: 'job panel'});
    await optionsRequest;
    const environment = dialog.getByLabel('environment');
    await expect(environment).toBeVisible();
    await expect(environment.getByRole('option', {name: 'Staging'})).toHaveCount(1);
});
