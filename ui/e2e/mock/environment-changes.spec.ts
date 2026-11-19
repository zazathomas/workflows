import {expect, Page, test} from '@playwright/test';

const template = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'WorkflowTemplate',
    metadata: {
        name: 'deploy',
        namespace: 'argo',
        uid: 'template-deploy',
        resourceVersion: '7',
        generation: 4,
        creationTimestamp: '2024-01-01T00:00:00Z',
        managedFields: [
            {manager: 'kubectl-edit', operation: 'Update', time: '2024-02-01T00:00:00Z', apiVersion: 'argoproj.io/v1alpha1'},
            {manager: 'argo-server', operation: 'Apply', time: '2024-03-01T00:00:00Z', apiVersion: 'argoproj.io/v1alpha1', subresource: 'status'}
        ]
    },
    spec: {
        entrypoint: 'main',
        templates: [{name: 'main', container: {image: 'alpine', command: ['echo'], args: ['hello']}}],
        arguments: {parameters: []}
    }
};

async function mockApi(page: Page) {
    await page.route('**/api/**', async route => {
        const {pathname: path, searchParams} = new URL(route.request().url());
        let json: unknown = {};
        if (path.endsWith('/extensions/run-action-policy')) json = {allowedHosts: []};
        else if (path.endsWith('/extensions/environment')) {
            const configMap = searchParams.get('kind') === 'ConfigMap';
            const resource = configMap ? {kind: 'ConfigMap', name: 'catalog'} : {kind: 'Secret', name: 'registry'};
            json = searchParams.has('name')
                ? {...resource, type: configMap ? undefined : 'kubernetes.io/dockerconfigjson', keys: [{name: configMap ? 'regions' : 'token', size: 12}]}
                : {items: [resource]};
        } else if (path.endsWith('/info')) json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path.endsWith('/userinfo')) json = {subject: 'test-user', serviceAccountNamespace: 'argo'};
        else if (path.endsWith('/version')) json = {version: 'test'};
        else if (path.endsWith('/namespaces')) json = {items: ['argo']};
        else if (path === '/api/v1/workflow-templates/argo/deploy') json = template;
        else if (path.startsWith('/api/v1/workflow-events/')) return route.fulfill({status: 200, contentType: 'text/event-stream', body: ': mock\n\n'});
        else if (path.endsWith('/workflows/argo') || path.endsWith('/workflows')) json = {metadata: {resourceVersion: '1'}, items: []};
        else if (path.endsWith('/workflow-templates/argo')) json = {items: [template]};
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)});
    });
}

test('the environment viewer lists keys and never values', async ({page}) => {
    await mockApi(page);
    await page.goto('/environment/argo');

    await expect(page.getByRole('table', {name: 'ConfigMaps'})).toBeVisible();
    await expect(page.getByText('catalog', {exact: true})).toBeVisible();
    await expect(page.getByText('regions', {exact: true})).toHaveCount(0);
    await page.getByRole('button', {name: 'Show keys for catalog'}).click();
    await expect(page.getByText('regions', {exact: true})).toBeVisible();
    await expect(page.getByText('registry', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Show keys for registry'}).click();
    await expect(page.getByText('kubernetes.io/dockerconfigjson')).toBeVisible();
    await expect(page.getByText(/Values are masked/)).toBeVisible();

    await page.getByRole('textbox', {name: 'Filter'}).fill('token');
    await expect(page.getByText('No ConfigMaps match the filter.')).toBeVisible();
    await expect(page.getByText('registry', {exact: true})).toBeVisible();
});

test('the Changes tab shows the managed fields history', async ({page}) => {
    await mockApi(page);
    await page.goto('/workflow-templates/argo/deploy?tab=changes');

    await expect(page.getByRole('tab', {name: 'Changes'})).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('table', {name: 'Object change history'})).toBeVisible();
    await expect(page.getByText('kubectl-edit')).toBeVisible();
    await expect(page.getByText('argo-server').first()).toBeVisible();
    await expect(page.getByText('Applied')).toBeVisible();
});
