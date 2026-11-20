import {concat, EMPTY, from, Observable, of} from 'rxjs';
import {catchError, filter, map, mergeMap, switchMap} from 'rxjs/operators';

import {NameFilterKeys} from '../../workflows/components/workflow-filters/workflow-filters';
import {uiUrl} from '../base';
import * as models from '../models';
import {Event, isWorkflowInCluster, LogEntry, NodeStatus, Workflow, WorkflowList, WorkflowPhase} from '../models';
import {ResubmitOpts, RetryOpts} from '../models';
import {SubmitOpts} from '../models/submit-opts';
import {Pagination} from '../pagination';
import {isRunnerNode} from '../template-resolution';
import requests from './requests';
import {WorkflowDeleteResponse} from './responses';
import {queryParams} from './utils';

function isString(value: any): value is string {
    return typeof value === 'string';
}

const MAX_LOG_RECONNECTS = 3;

function isNodePendingOrRunning(node: NodeStatus) {
    return node.phase === models.NODE_PHASE.PENDING || node.phase === models.NODE_PHASE.RUNNING;
}

function hasArtifactLogs(workflow: Workflow, nodeId: string, container: string) {
    const node = workflow.status.nodes[nodeId];
    return node?.outputs?.artifacts?.some(a => a.name === `${container}-logs`);
}

// The all-pods view has no node selected; logs archived to the artifact
// repository can still be shown when any node archived logs for this container.
function hasAnyArtifactLogs(workflow: Workflow, container: string) {
    return Object.values(workflow.status.nodes || {}).some(node => node.outputs?.artifacts?.some(a => a.name === `${container}-logs`));
}

export const WorkflowsService = {
    runView(namespace: string, view: 'summary' | 'gates', cursor?: string): Promise<WorkflowList> {
        const params = new URLSearchParams({namespace, view});
        if (cursor) params.set('continue', cursor);
        return requests.get(`api/v1/extensions/run-view?${params}`).then(res => res.body as WorkflowList);
    },

    approvalCount(namespace: string): Promise<number> {
        const params = new URLSearchParams({namespace, view: 'gate-count'});
        return requests.get(`api/v1/extensions/run-view?${params}`).then(res => res.body.count as number);
    },

    create(workflow: Workflow, namespace: string) {
        return requests
            .post(`api/v1/workflows/${namespace}`)
            .send({workflow})
            .then(res => res.body as Workflow);
    },

    list(
        namespace: string,
        phases: WorkflowPhase[],
        labels: string[],
        pagination: Pagination,
        fields = [
            'metadata',
            'items.metadata.uid',
            'items.metadata.name',
            'items.metadata.namespace',
            'items.metadata.creationTimestamp',
            'items.metadata.labels',
            'items.metadata.annotations',
            'items.status.phase',
            'items.status.message',
            'items.status.finishedAt',
            'items.status.startedAt',
            'items.status.estimatedDuration',
            'items.status.progress',
            'items.status.synchronization',
            'items.spec.suspend',
            'items.spec.arguments'
        ],
        name?: string,
        nameFilter?: NameFilterKeys,
        createdAfter?: Date,
        finishedBefore?: Date,
        archiveFilter?: 'all' | 'live' | 'archived',
        substring?: {nameTitleContains?: string; labelContains?: string}
    ) {
        const params = queryParams({phases, labels, pagination, name, nameFilter, createdAfter, finishedBefore, archiveFilter, ...substring});
        params.push(`fields=${fields.join(',')}`);
        return requests.get(`api/v1/workflows/${namespace}?${params.join('&')}`).then(res => res.body as WorkflowList);
    },

    get(namespace: string, name: string, uid?: string) {
        const params = uid ? `?uid=${uid}` : '';
        return requests.get(`api/v1/workflows/${namespace}/${name}${params}`).then(res => res.body as Workflow);
    },

    getArchived(namespace: string, uid: string) {
        return requests.get(`api/v1/archived-workflows/${uid}?namespace=${namespace}`).then(res => res.body as models.Workflow);
    },

    watch(query: {
        namespace?: string;
        name?: string;
        phases?: Array<WorkflowPhase>;
        labels?: Array<string>;
        resourceVersion?: string;
        archiveFilter?: 'all' | 'live' | 'archived';
    }): Observable<models.kubernetes.WatchEvent<Workflow>> {
        const url = `api/v1/workflow-events/${query.namespace || ''}?${queryParams(query).join('&')}`;
        return requests.loadEventSource(url).pipe(map(data => data && (JSON.parse(data).result as models.kubernetes.WatchEvent<Workflow>)));
    },

    watchEvents(namespace: string, fieldSelector: string): Observable<Event> {
        return requests
            .loadEventSource(`api/v1/stream/events/${namespace}?listOptions.fieldSelector=${fieldSelector}`)
            .pipe(map(data => data && (JSON.parse(data).result as Event)));
    },

    watchFields(query: {
        namespace?: string;
        name?: string;
        phases?: Array<WorkflowPhase>;
        labels?: Array<string>;
        resourceVersion?: string;
        archiveFilter?: 'all' | 'live' | 'archived';
    }): Observable<models.kubernetes.WatchEvent<Workflow>> {
        const params = queryParams(query);
        const fields = [
            'result.object.metadata.name',
            'result.object.metadata.namespace',
            'result.object.metadata.resourceVersion',
            'result.object.metadata.creationTimestamp',
            'result.object.metadata.uid',
            'result.object.status.finishedAt',
            'result.object.status.phase',
            'result.object.status.message',
            'result.object.status.startedAt',
            'result.object.status.estimatedDuration',
            'result.object.status.progress',
            'result.type',
            'result.object.metadata.labels',
            'result.object.metadata.annotations',
            'result.object.spec.suspend',
            'result.object.spec.arguments'
        ];
        params.push(`fields=${fields.join(',')}`);
        const url = `api/v1/workflow-events/${query.namespace || ''}?${params.join('&')}`;
        return requests.loadEventSource(url).pipe(map(data => data && (JSON.parse(data).result as models.kubernetes.WatchEvent<Workflow>)));
    },

    retry(name: string, namespace: string, opts?: RetryOpts) {
        return requests
            .put(`api/v1/workflows/${namespace}/${name}/retry`)
            .send(opts)
            .then(res => res.body as Workflow);
    },

    retryArchived(uid: string, namespace: string, opts?: RetryOpts) {
        return requests
            .put(`api/v1/archived-workflows/${uid}/retry`)
            .send({namespace, ...opts})
            .then(res => res.body as Workflow);
    },

    resubmit(name: string, namespace: string, opts?: ResubmitOpts) {
        return requests
            .put(`api/v1/workflows/${namespace}/${name}/resubmit`)
            .send(opts)
            .then(res => res.body as Workflow);
    },

    resubmitArchived(uid: string, namespace: string, opts?: ResubmitOpts) {
        return requests
            .put(`api/v1/archived-workflows/${uid}/resubmit`)
            .send({namespace, ...opts})
            .then(res => res.body as Workflow);
    },

    suspend(name: string, namespace: string) {
        return requests.put(`api/v1/workflows/${namespace}/${name}/suspend`).then(res => res.body as Workflow);
    },

    set(name: string, namespace: string, nodeFieldSelector: string, outputParameters: string) {
        return requests
            .put(`api/v1/workflows/${namespace}/${name}/set`)
            .send({nodeFieldSelector, outputParameters})
            .then(res => res.body as Workflow);
    },

    resume(name: string, namespace: string, nodeFieldSelector: string) {
        return requests
            .put(`api/v1/workflows/${namespace}/${name}/resume`)
            .send({nodeFieldSelector})
            .then(res => res.body as Workflow);
    },

    stop(name: string, namespace: string) {
        return requests.put(`api/v1/workflows/${namespace}/${name}/stop`).then(res => res.body as Workflow);
    },

    terminate(name: string, namespace: string) {
        return requests.put(`api/v1/workflows/${namespace}/${name}/terminate`).then(res => res.body as Workflow);
    },

    delete(name: string, namespace: string): Promise<WorkflowDeleteResponse> {
        return requests.delete(`api/v1/workflows/${namespace}/${name}`).then(res => res.body as WorkflowDeleteResponse);
    },

    deleteArchived(uid: string, namespace: string): Promise<WorkflowDeleteResponse> {
        if (namespace === '') {
            return requests.delete(`api/v1/archived-workflows/${uid}`).then(res => res.body as WorkflowDeleteResponse);
        } else {
            return requests.delete(`api/v1/archived-workflows/${uid}?namespace=${namespace}`).then(res => res.body as WorkflowDeleteResponse);
        }
    },

    submit(kind: string, name: string, namespace: string, submitOptions?: SubmitOpts) {
        return requests
            .post(`api/v1/workflows/${namespace}/submit`)
            .send({namespace, resourceKind: kind, resourceName: name, submitOptions})
            .then(res => res.body as Workflow);
    },

    // Emits null when the stream opens, so callers can tell a transient failure
    // apart from a run that simply has not printed a marker yet.
    watchRunActionLogs(namespace: string, name: string, marker: string, container: string, podName?: string): Observable<LogEntry | null> {
        const grep = '^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const params = new URLSearchParams({
            'logOptions.container': container,
            'logOptions.follow': 'true',
            grep
        });
        if (podName) params.set('podName', podName);
        return requests.loadEventSource(uiUrl(`api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/log?${params}`)).pipe(
            map(line => (line ? (JSON.parse(line).result as LogEntry) : null)),
            filter(entry => entry === null || isString(entry?.content))
        );
    },

    getContainerLogsFromCluster(workflow: Workflow, podName: string, container: string, grep: string): Observable<LogEntry> {
        return this.getContainerLogsFromClusterWithRetry(workflow, podName, container, grep, 0);
    },

    getContainerLogsFromClusterWithRetry(workflow: Workflow, podName: string, container: string, grep: string, reconnectCount: number): Observable<LogEntry> {
        const namespace = workflow.metadata.namespace;
        const name = workflow.metadata.name;
        const podLogsURL = uiUrl(
            `api/v1/workflows/${namespace}/${name}/log?logOptions.container=${container}&grep=${grep}&logOptions.follow=true${podName ? `&podName=${podName}` : ''}`
        );
        return requests.loadEventSource(podLogsURL).pipe(
            filter(line => !!line),
            map(line => JSON.parse(line).result as LogEntry),
            filter(e => isString(e.content)),
            catchError(() => {
                if (reconnectCount >= MAX_LOG_RECONNECTS) {
                    // Stop reconnecting after a few consecutive failures so a persistently
                    // unreachable endpoint does not loop forever. The subscriber completes and
                    // the logs panel shows its empty/error hint instead.
                    return EMPTY;
                }
                return from(this.getWorkflowNodePendingOrRunning(workflow, podName)).pipe(
                    switchMap(({isPendingOrRunning}) => {
                        if (isPendingOrRunning) {
                            return this.getContainerLogsFromClusterWithRetry(workflow, podName, container, grep, reconnectCount + 1);
                        }
                        return EMPTY;
                    })
                );
            })
        );
    },

    async getWorkflowNodePendingOrRunning(workflow: Workflow, nodeId?: string) {
        // We always refresh the workflow rather than inspecting the state locally since it doubles
        // as a check to determine whether or not the API is currently reachable
        const updatedWorkflow = await this.get(workflow.metadata.namespace, workflow.metadata.name);
        const node = updatedWorkflow.status.nodes[nodeId];
        if (!node) {
            return {workflow: updatedWorkflow, isPendingOrRunning: !updatedWorkflow.status || ['Pending', 'Running'].includes(updatedWorkflow.status.phase)};
        }
        return {workflow: updatedWorkflow, isPendingOrRunning: isNodePendingOrRunning(node)};
    },

    getContainerLogsFromArtifact(workflow: Workflow, nodeId: string, container: string, grep: string, archived: boolean): Observable<LogEntry> {
        return of(hasArtifactLogs(workflow, nodeId, container)).pipe(
            switchMap(isArtifactLogs => {
                if (!isArtifactLogs) {
                    if (!nodeId) {
                        throw new Error('Should specify a node when we get archived logs');
                    }
                    throw new Error('no artifact logs are available');
                }

                return from(requests.get(this.getArtifactLogsPath(workflow, nodeId, container, archived)));
            }),
            mergeMap(r => r.text.split('\n')),
            map(content => ({content, podName: workflow.status.nodes[nodeId]?.displayName ?? workflow.status.nodes[nodeId]?.name}) as LogEntry),
            filter(x => !!x.content.match(grep))
        );
    },

    /**
     * Logs archived to the artifact repository are stored per node, so the
     * all-pods view (no node selected) reads the logs of every node that
     * archived logs for this container, in the order the nodes were created.
     * A node whose archived logs cannot be fetched is skipped so one missing
     * artifact does not hide the rest; when no node archived logs nothing is
     * emitted, and the caller falls back to live pod logs.
     */
    getContainerLogsFromArtifacts(workflow: Workflow, nodeId: string, container: string, grep: string, archived: boolean): Observable<LogEntry> {
        if (nodeId) {
            return this.getContainerLogsFromArtifact(workflow, nodeId, container, grep, archived);
        }
        const nodeIds = Object.values(workflow.status.nodes || {})
            .filter(node => hasArtifactLogs(workflow, node.id, container))
            .map(node => node.id);
        if (nodeIds.length === 0) {
            return EMPTY;
        }
        return concat(...nodeIds.map(id => this.getContainerLogsFromArtifact(workflow, id, container, grep, archived).pipe(catchError(() => EMPTY))));
    },

    getContainerLogs(workflow: Workflow, podName: string, nodeId: string, container: string, grep: string, archived: boolean): Observable<LogEntry> {
        const getLogsFromArtifacts = (targetWorkflow = workflow) => this.getContainerLogsFromArtifacts(targetWorkflow, nodeId, container, grep, archived);
        const getLogsFromCluster = () => (isRunnerNode(workflow, workflow.status.nodes[nodeId]) ? EMPTY : this.getContainerLogsFromCluster(workflow, podName, container, grep));
        // whether the artifact repository holds archived logs for this selection:
        // the selected node's, or any node's in the all-pods view
        const hasArchivedLogs = (targetWorkflow: Workflow) => (nodeId ? hasArtifactLogs(targetWorkflow, nodeId, container) : hasAnyArtifactLogs(targetWorkflow, container));

        // If our workflow was deleted, try to get logs from artifacts.
        if (!isWorkflowInCluster(workflow)) {
            return getLogsFromArtifacts();
        }

        // Return archived logs once the workflow has finished and logs were
        // archived: the pods may have been garbage-collected, in which case the
        // live pod-log stream is empty or unreachable, so the archived copy is
        // the only source. Live pod logs remain the fallback (e.g. pods kept and
        // archive disabled).
        return from(this.getWorkflowNodePendingOrRunning(workflow, nodeId)).pipe(
            switchMap(({workflow: updatedWorkflow, isPendingOrRunning}) => {
                if (!isPendingOrRunning && hasArchivedLogs(updatedWorkflow)) {
                    return getLogsFromArtifacts(updatedWorkflow).pipe(catchError(getLogsFromCluster));
                }
                return getLogsFromCluster().pipe(catchError(() => getLogsFromArtifacts(updatedWorkflow)));
            })
        );
    },

    getArtifactLogsPath(workflow: Workflow, nodeId: string, container: string, archived: boolean) {
        return this.artifactPath(workflow, nodeId, container + '-logs', archived, false);
    },

    getArtifactDownloadUrl(workflow: Workflow, nodeId: string, artifactName: string, archived: boolean, isInput: boolean) {
        return uiUrl(this.artifactPath(workflow, nodeId, artifactName, archived, isInput));
    },

    artifactPath(workflow: Workflow, nodeId: string, artifactName: string, archived: boolean, isInput: boolean) {
        return `artifact-files/${workflow.metadata.namespace}/${archived ? 'archived-workflows' : 'workflows'}/${
            archived ? workflow.metadata.uid : workflow.metadata.name
        }/${nodeId}/${isInput ? 'inputs' : 'outputs'}/${artifactName}`;
    }
};
