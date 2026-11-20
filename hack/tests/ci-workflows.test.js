// Run after installing UI dependencies: node --test hack/tests/ci-workflows.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('../../ui/node_modules/yaml');

const root = path.resolve(__dirname, '../..');
const workflow = name => yaml.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const ci = workflow('ci-build.yaml');
const compatibility = workflow('compatibility.yaml');
const release = workflow('release.yaml');
const actionSteps = (job, action) => (job.steps || []).filter(step => step.uses?.startsWith(`${action}@`));
const commands = job => job.steps.filter(step => step.run).map(step => step.run).join('\n');
const dependencies = job => [job.needs || []].flat().sort();
const clusterCondition = "github.event_name != 'pull_request' && inputs.scope != 'contract'";

// These checks exercise workflow wiring that actionlint cannot validate:
// artifact producer/consumer identity, retained test commands, and event scope.
test('one CI invocation owns contracts, runner checks, and main-branch clusters', () => {
    assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'push', 'schedule']);
    assert.deepEqual(ci.on.push.branches, ['main']);
    assert.equal(ci.jobs.compatibility.uses, './.github/workflows/compatibility.yaml');
    assert.equal(ci.jobs.compatibility.with['runner-tests'], true);
    assert.equal(ci.jobs.compatibility.with.scope, "${{ github.event_name == 'push' && 'full' || 'contract' }}");
    assert.equal(compatibility.on.pull_request, undefined);
    assert.equal(compatibility.on.push, undefined);
    assert.deepEqual(compatibility.on.schedule, [{cron: '45 3 * * 0'}]);
    assert.deepEqual(compatibility.on.workflow_dispatch.inputs.scope.options, ['full', 'contract']);
    assert.equal(compatibility.on.workflow_dispatch.inputs.scope.default, 'full');
    assert.equal(compatibility.on.workflow_call.inputs.scope.default, 'full');
    assert.equal(compatibility.on.workflow_call.inputs['runner-tests'].default, false);
    // Called workflows inherit github.workflow; distinct prefixes avoid
    // cancelling the caller when compatibility starts.
    assert.notEqual(compatibility.concurrency.group, ci.concurrency.group);
    assert.notEqual(compatibility.concurrency.group, release.concurrency.group);
});

test('one contract job still fetches and checks every registered release', () => {
    const contract = compatibility.jobs.contract;
    assert.equal(contract.strategy, undefined);
    assert.match(commands(contract), /^make upstream-versions$/m);
    assert.match(commands(contract), /^make upstream-contract$/m);
});

test('each image has one producer and gzip artifacts are not recompressed', () => {
    const expected = {
        'server-image': ['workflows-image', 'Dockerfile'],
        'runner-image': ['workflows-runner-image', 'Dockerfile.runner'],
        'broker-image': ['workflows-runner-broker-image', 'Dockerfile.runner-broker']
    };
    for (const [jobName, [artifact, dockerfile]] of Object.entries(expected)) {
        const job = compatibility.jobs[jobName];
        const builds = actionSteps(job, 'docker/build-push-action');
        assert.equal(builds.length, 1);
        assert.equal(builds[0].with.file || 'Dockerfile', dockerfile);
        assert.equal(builds[0].with.platforms, 'linux/amd64');
        const uploads = actionSteps(job, 'actions/upload-artifact');
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].with.name, artifact);
        assert.equal(uploads[0].with.path, `${artifact}.tar.gz`);
        assert.equal(uploads[0].with['compression-level'], 0);
        assert.equal(uploads[0].with['if-no-files-found'], 'error');
    }
    const runnerBuilds = [...Object.values(ci.jobs), ...Object.values(compatibility.jobs)]
        .flatMap(job => actionSteps(job, 'docker/build-push-action'))
        .filter(step => step.with.file === 'Dockerfile.runner');
    assert.equal(runnerBuilds.length, 1);
});

test('runner tests and conformance consume the same image artifact within one run', () => {
    for (const jobName of ['runner', 'runner-conformance']) {
        const job = compatibility.jobs[jobName];
        assert.ok(dependencies(job).includes('runner-image'));
        const downloads = actionSteps(job, 'actions/download-artifact')
            .filter(step => step.with.name === 'workflows-runner-image');
        assert.equal(downloads.length, 1);
        assert.equal(downloads[0].with['run-id'], undefined);
        assert.match(commands(job), /docker load < workflows-runner-image\.tar\.gz/);
        assert.match(commands(job), /workflows-runner:compatibility/);
    }
});

test('cluster suites wait only for the images they actually consume', () => {
    assert.deepEqual(dependencies(compatibility.jobs.conformance), ['registry', 'server-image']);
    assert.deepEqual(dependencies(compatibility.jobs['runner-conformance']), ['broker-image', 'registry', 'runner-image']);
    assert.deepEqual(dependencies(compatibility.jobs.runner), ['runner-image']);
    for (const jobName of ['conformance', 'runner-conformance']) {
        const job = compatibility.jobs[jobName];
        assert.equal(job.if, clusterCondition);
        assert.equal(job.strategy['fail-fast'], false);
        assert.equal(job.strategy.matrix.version, '${{ fromJSON(needs.registry.outputs.cluster_versions) }}');
    }
    for (const jobName of ['server-image', 'broker-image']) {
        assert.equal(compatibility.jobs[jobName].if, clusterCondition);
    }
    assert.equal(compatibility.jobs.runner.if, 'inputs.runner-tests');
    assert.equal(compatibility.jobs['runner-image'].if, `inputs.runner-tests || (${clusterCondition})`);
});

test('Go, database, runner integration, and security checks remain enabled', () => {
    assert.match(commands(ci.jobs.server), /^go test -p 2 \.\/\.\.\.$/m);
    assert.match(commands(ci.jobs.server), /TestAPIFixturesExist/);
    assert.ok(ci.jobs.server.services['broker-postgres']);
    const goTest = ci.jobs.server.steps.find(step => step.name === 'Test every Go package');
    assert.equal(goTest.env.BROKER_TEST_DATABASE_URL,
        "postgres://broker:broker-ci-only@127.0.0.1:${{ job.services.broker-postgres.ports['5432'] }}/broker?sslmode=disable");
    assert.match(commands(compatibility.jobs.runner), /hack\/test-runner-dind\.sh workflows-runner:compatibility/);
    assert.match(commands(compatibility.jobs.runner), /RUNNER_DOCKER_INTEGRATION=1/);
    assert.match(commands(compatibility.jobs.runner), /-count=1/);
    assert.match(commands(compatibility.jobs.runner), /TestIntegrationExecutor/);
    assert.match(commands(ci.jobs.image), /fs --scanners vuln --include-dev-deps/);
    assert.match(commands(ci.jobs.image), /image --image-src docker --scanners vuln/);
});

test('Playwright container matches the lockfile and retains all UI checks', () => {
    const lock = fs.readFileSync(path.join(root, 'ui/yarn.lock'), 'utf8');
    const version = lock.match(/^"@playwright\/test@[^"\n]+":\n  version "([^"\n]+)"/m)?.[1];
    assert.ok(version);
    const ui = ci.jobs.ui;
    assert.equal(ui.container.image, `mcr.microsoft.com/playwright:v${version}`);
    assert.equal(ui.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
    assert.equal(actionSteps(ui, 'actions/setup-node')[0].with['node-version'], '24');
    assert.match(commands(ui), /^yarn --cwd ui test --runInBand$/m);
    assert.match(commands(ui), /^yarn --cwd ui lint$/m);
    assert.match(commands(ui), /^yarn --cwd ui playwright test -c playwright\.mock\.config\.ts$/m);
    assert.doesNotMatch(commands(ui), /playwright install/);
    assert.match(commands(ui), /assert\.equal\(pkg\.version, image\.driverVersion/);
});

test('release validates its tag before compatibility and keeps architecture caches', () => {
    assert.deepEqual(dependencies(release.jobs.compatibility), ['guard']);
    assert.equal(release.jobs.compatibility.with.scope, 'full');
    assert.deepEqual(dependencies(release.jobs.release), ['compatibility', 'guard']);
    assert.deepEqual(dependencies(release.jobs['runner-image']), ['compatibility', 'guard']);
    for (const arch of ['amd64', 'arm64']) {
        const build = release.jobs.release.steps.find(step => step.id === arch);
        assert.equal(build.with['cache-from'].trim(),
            `type=gha,scope=server-image-${arch}\ntype=gha,scope=server-image`);
        assert.equal(build.with['cache-to'], `type=gha,mode=max,scope=server-image-${arch}`);
        assert.match(build.with['build-args'], /VERSION=\$\{\{ github.ref_name \}\}/);
    }
    assert.match(commands(release.jobs.release), /for arch in amd64 arm64/);
    assert.match(commands(release.jobs.release), /--severity HIGH,CRITICAL --exit-code 1/);
    assert.match(commands(release.jobs.release), /cosign attest/);
    assert.match(commands(release.jobs['runner-image']), /cosign attest/);
});
