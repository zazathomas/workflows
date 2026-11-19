// Dark-mode screenshot tour of the workflows console (mock-backed).
// Runs from the Playwright container against the containerized dev server:
//   node screenshot-dark.mjs
// All API traffic is intercepted; no cluster is needed. Screenshots land in /shots.

import {chromium} from '@playwright/test';
import {mkdirSync} from 'fs';

const BASE = process.env.ARGO_UI_BASE_URL || 'http://ui-dev-shots:8080';
const OUT = process.env.SHOTS_DIR || '/shots';
mkdirSync(OUT, {recursive: true});

// --- fixtures ---------------------------------------------------------------

const wf = (name, uid, phase, extra = {}) => ({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
        name,
        namespace: 'argo',
        uid,
        creationTimestamp: '2025-06-02T09:00:00Z',
        labels: {'workflows.argoproj.io/workflow-template': 'deploy-service', ...extra.labels},
        annotations: extra.annotations
    },
    spec: {},
    status: {
        phase,
        startedAt: '2025-06-02T09:00:00Z',
        finishedAt: extra.finishedAt,
        progress: extra.progress,
        message: extra.message,
        estimatedDuration: 300,
        nodes: extra.nodes
    }
});

const node = (id, name, type, phase, opts = {}) => ({
    id,
    name,
    displayName: name,
    templateName: opts.template || 'main',
    type,
    phase,
    boundaryID: opts.boundaryID,
    children: opts.children || [],
    startedAt: opts.startedAt || '2025-06-02T09:00:00Z',
    finishedAt: opts.finishedAt,
    message: opts.message
});

// The hero run: running, with steps across every phase so the summary's
// box score, the DAG and the timeline all have something to show.
const heroNodes = {
    'waiting-run': node('waiting-run', 'waiting-run', 'Steps', 'Running', {children: ['deploy-api', 'deploy-web', 'test-suite', 'wait-approval']}),
    'deploy-api': node('deploy-api', 'deploy-api', 'Pod', 'Succeeded', {template: 'deploy', boundaryID: 'waiting-run', startedAt: '2025-06-02T09:00:05Z', finishedAt: '2025-06-02T09:02:10Z'}),
    'deploy-web': node('deploy-web', 'deploy-web', 'Pod', 'Running', {template: 'deploy', boundaryID: 'waiting-run', startedAt: '2025-06-02T09:02:20Z'}),
    'test-suite': node('test-suite', 'test-suite', 'Pod', 'Failed', {template: 'test', boundaryID: 'waiting-run', startedAt: '2025-06-02T09:01:00Z', finishedAt: '2025-06-02T09:05:00Z', message: 'integration test timed out'}),
    'wait-approval': node('wait-approval', 'wait-approval', 'Suspend', 'Running', {boundaryID: 'waiting-run', startedAt: '2025-06-02T09:06:00Z'}),
    'notify': node('notify', 'notify', 'Pod', 'Pending', {template: 'notify', boundaryID: 'waiting-run'}),
    'cleanup': node('cleanup', 'cleanup', 'Pod', 'Skipped', {template: 'cleanup', boundaryID: 'waiting-run'})
};

const heroRun = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
        name: 'waiting-run',
        namespace: 'argo',
        uid: 'run-waiting',
        creationTimestamp: '2025-06-02T09:00:00Z',
        labels: {'workflows.argoproj.io/workflow-template': 'deploy-service', 'workflows.argoproj.io/creator': 'zaza'},
        annotations: {'workflows.argoproj.io/title': 'Nightly deploy', 'workflows.argoproj.io/description': 'Production deploy with gate approval'}
    },
    spec: {
        activeDeadlineSeconds: 3600,
        ttlStrategy: {secondsAfterCompletion: 600},
        podGC: {strategy: 'OnWorkflowCompletion'},
        securityContext: {runAsNonRoot: true}
    },
    status: {
        phase: 'Running',
        startedAt: '2025-06-02T09:00:00Z',
        progress: '4/7',
        estimatedDuration: 480,
        conditions: [],
        nodes: heroNodes
    }
};

const runs = [
    heroRun,
    wf('nightly-etl-7f2ab', 'run-etl', 'Succeeded', {finishedAt: '2025-06-02T08:40:00Z', labels: {'workflows.argoproj.io/cron-workflow': 'nightly-etl'}, annotations: {'workflows.argoproj.io/title': 'Nightly ETL'}}),
    wf('deploy-service-x91zq', 'run-failed', 'Failed', {finishedAt: '2025-06-02T08:10:00Z', message: 'Error (exit code 1): build failed', labels: {'workflows.argoproj.io/creator': 'zaza'}}),
    wf('data-backfill-3kdm1', 'run-error', 'Error', {finishedAt: '2025-06-02T07:55:00Z', message: 'workflow shutdown: deadline exceeded'}),
    wf('train-model-b9x4k', 'run-pending', 'Pending', {labels: {'workflows.argoproj.io/creator': 'sam'}}),
    wf('nightly-etl-7f1zz', 'run-etl-2', 'Succeeded', {finishedAt: '2025-06-01T08:35:00Z', labels: {'workflows.argoproj.io/cron-workflow': 'nightly-etl'}})
];

const templates = {
    items: [
        {metadata: {name: 'deploy-service', namespace: 'argo', creationTimestamp: '2025-05-01T10:00:00Z', labels: {'workflows.argoproj.io/job': 'true'}}, spec: {arguments: {parameters: [{name: 'environment', value: 'production'}]}}},
        {metadata: {name: 'nightly-etl', namespace: 'argo', creationTimestamp: '2025-04-12T10:00:00Z'}, spec: {}},
        {metadata: {name: 'train-model', namespace: 'argo', creationTimestamp: '2025-03-30T10:00:00Z'}, spec: {}}
    ]
};

const crons = {
    items: [
        {metadata: {name: 'nightly-etl', namespace: 'argo', creationTimestamp: '2025-04-12T10:00:00Z'}, spec: {schedules: ['0 2 * * *'], timezone: 'UTC'}},
        {metadata: {name: 'weekly-report', namespace: 'argo', creationTimestamp: '2025-05-20T10:00:00Z'}, spec: {schedules: ['0 6 * * 1'], timezone: 'Europe/Berlin'}}
    ]
};

const eventSources = {
    items: [
        {metadata: {name: 'webhook-gateway', namespace: 'argo'}, spec: {webhook: {example: {port: '12000', endpoint: '/example', method: 'POST'}}}},
        {metadata: {name: 'calendar-events', namespace: 'argo'}, spec: {calendar: {example: {interval: '10m'}}}}
    ]
};

const sensors = {
    items: [
        {
            metadata: {name: 'on-deploy-request', namespace: 'argo'},
            spec: {
                dependencies: [{name: 'deploy-gate', eventSourceName: 'webhook-gateway', eventName: 'example'}],
                triggers: [{template: {name: 'trigger-run', k8s: {operation: 'create'}}}]
            }
        }
    ]
};

const environment = {
    namespace: 'argo',
    configMaps: [
        {kind: 'ConfigMap', name: 'catalog', createdAt: '2025-04-01T00:00:00Z', keys: [{name: 'regions', size: 12}, {name: 'features', size: 48}]},
        {kind: 'ConfigMap', name: 'runner-config', createdAt: '2025-05-11T00:00:00Z', keys: [{name: 'pools', size: 9}]}
    ],
    secrets: [
        {kind: 'Secret', name: 'registry', type: 'kubernetes.io/dockerconfigjson', createdAt: '2025-02-01T00:00:00Z', keys: [{name: '.dockerconfigjson', size: 812}]},
        {kind: 'Secret', name: 'github-webhook', type: 'Opaque', createdAt: '2025-03-05T00:00:00Z', keys: [{name: 'token', size: 18}]}
    ]
};

// Runners admin shapes follow the runner-admin e2e spec (docs/runners.md).
const runnerPools = {
    items: [
        {pool: 'edge-eu', namespaces: ['argo'], maxConcurrency: 4, maxConcurrentPerRunner: 2, requireDigest: true, queueDepth: 1},
        {pool: 'build', namespaces: [], maxConcurrency: 2, maxConcurrentPerRunner: 1, requireDigest: false, queueDepth: 0}
    ]
};
const runnerHosts = {
    items: [
        {id: 'r-abc123', pool: 'edge-eu', status: 'active', hostname: 'eu-host-1', version: 'v4.1.6+dev', flavour: 'dind', lastSeen: '2025-06-01T12:00:00Z', enrolledAt: '2025-05-01T08:00:00Z'},
        {id: 'r-def456', pool: 'edge-eu', status: 'quarantined', hostname: 'eu-host-2', version: 'v4.1.6+dev', flavour: 'dind', lastSeen: '2025-06-01T11:30:00Z', enrolledAt: '2025-05-02T08:00:00Z'}
    ]
};
const joinTokens = {items: [{name: 'runner-join-abc12345', pool: 'edge-eu', expiresAt: '2025-06-01T12:15:00Z'}]};
const runnerJobs = {
    items: [{name: 'runner-job-9f8e7d', pool: 'edge-eu', runnerID: 'r-abc123', attempt: 1, workflowNamespace: 'argo', workflowName: 'runner-run', nodeID: 'runner-run-1234567890', phase: 'running'}]
};

// --- API mock ---------------------------------------------------------------
// The app requests collection endpoints with and without a namespace segment
// and with or without a trailing slash; normalise the path before matching.

async function mockApi(page) {
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname.replace(/\/+$/, '');
        let json = {};

        if (path === '/api/v1/info') json = {managedNamespace: '', columns: [], links: [], modals: {}};
        else if (path === '/api/v1/userinfo') json = {subject: 'zaza@example', serviceAccountNamespace: 'argo'};
        else if (path === '/api/v1/version') json = {version: 'v4.1.5'};
        else if (path === '/api/v1/namespaces') json = {items: ['argo']};
        else if (path.endsWith('/extensions/run-action-policy')) json = {allowedHosts: []};
        else if (path.endsWith('/extensions/environment')) json = environment;
        else if (path.endsWith('/extensions/runners/admin/pools')) json = runnerPools;
        else if (path.endsWith('/extensions/runners/admin/runners')) json = runnerHosts;
        else if (path.endsWith('/extensions/runners/admin/jointokens')) json = joinTokens;
        else if (path.endsWith('/extensions/runners/admin/jobs')) json = runnerJobs;
        else if (path.endsWith('/workflows/argo/waiting-run')) json = heroRun;
        else if (/\/workflows(\/argo)?$/.test(path)) json = {metadata: {resourceVersion: '1'}, items: runs};
        else if (/\/cron-workflows(\/argo)?$/.test(path)) json = crons;
        else if (/\/cluster-workflow-templates$/.test(path)) json = {items: []};
        else if (/\/workflow-templates(\/argo)?$/.test(path)) json = templates;
        else if (/\/event-sources(\/argo)?$/.test(path)) json = eventSources;
        else if (/\/sensors(\/argo)?$/.test(path)) json = sensors;
        else if (path.includes('/stream/') || path.includes('/workflow-events') || path.endsWith('/log')) {
            // Watches: leave the request pending forever so no connection-closed
            // error or toast ever fires; the page rests on its REST data.
            return new Promise(() => {});
        }
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)});
    });
}

// --- tour --------------------------------------------------------------------

const shots = [
    {name: '01-login', path: '/login', wait: '.login__panel, form'},
    {name: '02-dashboard', path: '/dashboard', wait: 'text=Running now', settle: 1500},
    {name: '03-runs', path: '/workflows', wait: '.argo-table-list__row', settle: 800},
    {name: '04-run-summary', path: '/workflows/argo/waiting-run?uid=run-waiting', wait: '.node-box-score', settle: 800},
    {name: '05-run-graph', path: '/workflows/argo/waiting-run?uid=run-waiting&tab=workflow', wait: '.graph', settle: 1200},
    {name: '06-run-timeline', path: '/workflows/argo/waiting-run?uid=run-waiting&tab=timeline', wait: '.workflow-timeline', settle: 800},
    {name: '07-approvals', path: '/approvals', wait: 'text=wait-approval', settle: 500},
    {name: '08-jobs', path: '/workflow-templates', wait: 'text=deploy-service', settle: 800},
    {name: '09-schedules', path: '/cron-workflows', wait: 'text=nightly-etl', settle: 800},
    {name: '10-event-flow', path: '/event-flow', wait: 'text=on-deploy-request', settle: 2500},
    {name: '11-reports', path: '/reports', settle: 2500},
    {name: '12-runners', path: '/runners', wait: 'text=eu-host-1', settle: 800},
    {name: '13-environment', path: '/environment/argo', wait: 'text=registry', settle: 800},
    {name: '14-help', path: '/help', settle: 1200}
];

// Optional CLI knobs: VIEWPORT_W/VIEWPORT_H (default 1440x900) and ONLY (comma-
// separated shot-name substrings) to re-shoot a subset, e.g. at a taller
// viewport where the whole navigation rail fits.
const VW = parseInt(process.env.VIEWPORT_W || '1440', 10);
const VH = parseInt(process.env.VIEWPORT_H || '900', 10);
const only = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.trim()) : null;
const selected = only ? shots.filter(s => only.some(n => s.name.includes(n))) : shots;

const browser = await chromium.launch();
const failures = [];

for (const shot of selected) {
    const context = await browser.newContext({viewport: {width: VW, height: VH}, colorScheme: 'dark'});
    const page = await context.newPage();
    await page.addInitScript(() => {
        localStorage.setItem('argo-ui-theme', 'dark');
        localStorage.setItem('modal/ftu', '"dismissed"');
    });
    await mockApi(page);
    try {
        await page.goto(BASE + shot.path, {waitUntil: 'domcontentloaded', timeout: 30000});
        if (shot.wait) await page.waitForSelector(shot.wait, {timeout: 15000}).catch(() => failures.push(`${shot.name}: wait selector not found`));
        await page.waitForTimeout(shot.settle || 500);
        // Error toasts auto-close after 10s; wait them out for a clean shot.
        await page.waitForFunction(() => document.querySelectorAll('.Toastify__toast').length === 0, {timeout: 12000}).catch(() => {});
        await page.waitForTimeout(300);
        await page.screenshot({path: `${OUT}/${shot.name}.png`, fullPage: false});
        console.log(`ok ${shot.name}`);
    } catch (err) {
        failures.push(`${shot.name}: ${err.message.split('\n')[0]}`);
        console.log(`FAIL ${shot.name}: ${err.message.split('\n')[0]}`);
    } finally {
        await context.close();
    }
}

await browser.close();
if (failures.length) {
    console.log('FAILURES:', failures.join(' | '));
} else {
    console.log('all screenshots captured');
}
