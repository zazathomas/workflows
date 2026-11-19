/**
 * @jest-environment jsdom
 */
import {firstValueFrom, of, throwError, toArray} from 'rxjs';

import {Workflow} from '../models';
import requests from './requests';
import {WorkflowsService} from './workflows-service';

jest.mock('./requests');

const workflow = (name: string, namespace: string, uid: string): Workflow => {
    return {
        metadata: {
            name,
            namespace,
            uid
        },
        spec: {}
    };
};

describe('workflow service', () => {
    const service = WorkflowsService;

    afterEach(() => jest.restoreAllMocks());

    test('watches only marked log lines with a literal escaped marker', async () => {
        (requests.loadEventSource as jest.Mock).mockReturnValue(of(JSON.stringify({result: {content: 'AUTH.[1]:{"id":"one"}', podName: 'pod-1'}})));
        const entry = await firstValueFrom(service.watchRunActionLogs('argo', 'job-run', 'AUTH.[1]:', 'main'));
        expect(entry.podName).toBe('pod-1');
        const url = new URL((requests.loadEventSource as jest.Mock).mock.calls[0][0], 'https://ui.test');
        expect(url.pathname).toBe('/api/v1/workflows/argo/job-run/log');
        expect(url.searchParams.get('grep')).toBe('^AUTH\\.\\[1\\]:');
        expect(url.searchParams.get('logOptions.container')).toBe('main');
        expect(url.searchParams.get('logOptions.follow')).toBe('true');
    });

    test('getArtifactLogsUrl', () => {
        expect(service.getArtifactLogsPath(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-container', false)).toBe(
            'artifact-files/argo/workflows/hello-world/test-node/outputs/test-container-logs'
        );
        expect(service.getArtifactLogsPath(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-container', true)).toBe(
            'artifact-files/argo/archived-workflows/test-uid/test-node/outputs/test-container-logs'
        );
    });

    test('getArtifactDownloadUrl', () => {
        expect(service.getArtifactDownloadUrl(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-artifact', false, false)).toBe(
            '/artifact-files/argo/workflows/hello-world/test-node/outputs/test-artifact'
        );
        expect(service.getArtifactDownloadUrl(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-artifact', true, false)).toBe(
            '/artifact-files/argo/archived-workflows/test-uid/test-node/outputs/test-artifact'
        );
        expect(service.getArtifactDownloadUrl(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-artifact', false, true)).toBe(
            '/artifact-files/argo/workflows/hello-world/test-node/inputs/test-artifact'
        );
        expect(service.getArtifactDownloadUrl(workflow('hello-world', 'argo', 'test-uid'), 'test-node', 'test-artifact', true, true)).toBe(
            '/artifact-files/argo/archived-workflows/test-uid/test-node/inputs/test-artifact'
        );
    });

    test('getContainerLogs for completed container set', async () => {
        const completedWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            spec: {
                templates: [
                    {
                        name: 'container-set',
                        containerSet: {containers: [{name: 'step-1'}]}
                    }
                ]
            },
            status: {
                nodes: {
                    'test-node': {
                        id: 'test-node',
                        phase: 'Succeeded',
                        templateName: 'container-set',
                        outputs: {artifacts: [{name: 'step-1-logs'}]}
                    }
                }
            }
        } as unknown as Workflow;
        const requestedWorkflow = workflow('hello-world', 'argo', 'test-uid');
        jest.spyOn(service, 'get').mockResolvedValue(completedWorkflow);
        const getArtifactLogs = jest.spyOn(service, 'getContainerLogsFromArtifact').mockReturnValue(of({content: 'from artifact', podName: 'test-pod'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const log = await firstValueFrom(service.getContainerLogs(requestedWorkflow, 'test-pod', 'test-node', 'step-1', '', false));

        expect(log.content).toBe('from artifact');
        expect(service.get).toHaveBeenCalledWith('argo', 'hello-world');
        expect(getArtifactLogs).toHaveBeenCalledWith(completedWorkflow, 'test-node', 'step-1', '', false);
        expect(getClusterLogs).not.toHaveBeenCalled();
    });

    test('getContainerLogs for completed main container', async () => {
        const completedWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            spec: {templates: [{name: 'normal-container'}]},
            status: {
                nodes: {
                    'test-node': {
                        id: 'test-node',
                        phase: 'Succeeded',
                        templateName: 'normal-container',
                        outputs: {artifacts: [{name: 'main-logs'}]}
                    }
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(completedWorkflow);
        const getArtifactLogs = jest.spyOn(service, 'getContainerLogsFromArtifact').mockReturnValue(of({content: 'from artifact', podName: 'test-pod'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const log = await firstValueFrom(service.getContainerLogs(workflow('test-workflow-1', 'argo', 'test-uid'), 'test-pod', 'test-node', 'main', '', false));

        expect(log.content).toBe('from artifact');
        expect(getArtifactLogs).toHaveBeenCalledWith(completedWorkflow, 'test-node', 'main', '', false);
        expect(getClusterLogs).not.toHaveBeenCalled();
    });

    test('getContainerLogs for a container not in the node', async () => {
        const completedWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            spec: {templates: [{name: 'normal-container'}]},
            status: {
                nodes: {
                    'test-node': {
                        id: 'test-node',
                        phase: 'Succeeded',
                        templateName: 'normal-container',
                        outputs: {artifacts: [{name: 'some-other-step-logs'}]}
                    }
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(completedWorkflow);
        const getArtifactLogs = jest.spyOn(service, 'getContainerLogsFromArtifact').mockReturnValue(of({content: 'from artifact', podName: 'test-pod'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const log = await firstValueFrom(service.getContainerLogs(completedWorkflow, 'test-pod', 'test-node', 'missing-container', '', false));

        expect(log.content).toBe('from cluster');
        expect(getArtifactLogs).not.toHaveBeenCalled();
        expect(getClusterLogs).toHaveBeenCalledWith(completedWorkflow, 'test-pod', 'missing-container', '');
    });

    test('getContainerLogs for a container in inline template', async () => {
        const completedWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            spec: {
                templates: [
                    {
                        name: 'inline-template',
                        dag: {
                            tasks: [
                                {
                                    name: 'some-template',
                                    inline: {
                                        containerSet: {
                                            containers: [
                                                {
                                                    name: 'step-1'
                                                },
                                                {
                                                    name: 'step-2'
                                                }
                                            ]
                                        }
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
            status: {
                nodes: {
                    'test-node': {
                        id: 'test-node',
                        phase: 'Succeeded',
                        type: 'Pod',
                        templateName: '',
                        outputs: {artifacts: [{name: 'step-1-logs'}, {name: 'step-2-logs'}]}
                    }
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(completedWorkflow);
        const getArtifactLogs = jest.spyOn(service, 'getContainerLogsFromArtifact').mockReturnValue(of({content: 'from artifact', podName: 'test-pod'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const log = await firstValueFrom(service.getContainerLogs(completedWorkflow, 'test-pod', 'test-node', 'step-1', '', false));

        expect(log.content).toBe('from artifact');
        expect(getArtifactLogs).toHaveBeenCalledWith(completedWorkflow, 'test-node', 'step-1', '', false);
        expect(getClusterLogs).not.toHaveBeenCalled();
    });

    test('getContainerLogs aggregates the archived logs of every node in the all-pods view', async () => {
        const multiNodeWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            status: {
                phase: 'Succeeded',
                nodes: {
                    'node-a': {id: 'node-a', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step A', outputs: {artifacts: [{name: 'main-logs'}]}},
                    'node-b': {id: 'node-b', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step B', outputs: {artifacts: [{name: 'main-logs'}]}},
                    'node-c': {id: 'node-c', phase: 'Succeeded', type: 'Pod', templateName: 'step'}
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(multiNodeWorkflow);
        const getArtifactLogs = jest
            .spyOn(service, 'getContainerLogsFromArtifact')
            .mockImplementation((_wf, nodeId) => of({content: `from artifact ${nodeId}`, podName: nodeId === 'node-a' ? 'Step A' : 'Step B'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        // the all-pods view passes no pod name and no node id
        const entries = await firstValueFrom(service.getContainerLogs(multiNodeWorkflow, '', undefined, 'main', '', false).pipe(toArray()));

        // node-c archived no logs, so only node-a and node-b contribute, in node order
        expect(entries.map(e => e.content)).toEqual(['from artifact node-a', 'from artifact node-b']);
        expect(entries.map(e => e.podName)).toEqual(['Step A', 'Step B']);
        expect(getArtifactLogs).toHaveBeenCalledTimes(2);
        expect(getClusterLogs).not.toHaveBeenCalled();
    });

    test('getContainerLogs skips nodes whose archived logs cannot be fetched in the all-pods view', async () => {
        const multiNodeWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            status: {
                phase: 'Succeeded',
                nodes: {
                    'node-a': {id: 'node-a', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step A', outputs: {artifacts: [{name: 'main-logs'}]}},
                    'node-b': {id: 'node-b', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step B', outputs: {artifacts: [{name: 'main-logs'}]}}
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(multiNodeWorkflow);
        const getArtifactLogs = jest
            .spyOn(service, 'getContainerLogsFromArtifact')
            .mockImplementation((_wf, nodeId) =>
                nodeId === 'node-a' ? throwError(() => new Error('artifact not found')) : of({content: 'from artifact node-b', podName: 'Step B'})
            );
        jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const entries = await firstValueFrom(service.getContainerLogs(multiNodeWorkflow, '', undefined, 'main', '', false).pipe(toArray()));

        // one missing artifact must not hide the logs that are readable
        expect(entries.map(e => e.content)).toEqual(['from artifact node-b']);
        expect(getArtifactLogs).toHaveBeenCalledTimes(2);
    });

    test('getContainerLogs falls back to live pod logs when no node archived logs in the all-pods view', async () => {
        const noArtifactsWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            status: {
                phase: 'Succeeded',
                nodes: {
                    'node-a': {id: 'node-a', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step A'}
                }
            }
        } as unknown as Workflow;
        jest.spyOn(service, 'get').mockResolvedValue(noArtifactsWorkflow);
        const getArtifactLogs = jest.spyOn(service, 'getContainerLogsFromArtifact').mockReturnValue(of({content: 'from artifact', podName: 'test-pod'}));
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const log = await firstValueFrom(service.getContainerLogs(noArtifactsWorkflow, '', undefined, 'main', '', false));

        expect(log.content).toBe('from cluster');
        expect(getArtifactLogs).not.toHaveBeenCalled();
        expect(getClusterLogs).toHaveBeenCalledWith(noArtifactsWorkflow, '', 'main', '');
    });

    test('getContainerLogs reads archived logs across all nodes for a workflow deleted from the cluster', async () => {
        const persistedWorkflow = {
            ...workflow('test-workflow-1', 'argo', 'test-uid'),
            metadata: {...workflow('test-workflow-1', 'argo', 'test-uid').metadata, labels: {'workflows.argoproj.io/workflow-archiving-status': 'Persisted'}},
            status: {
                phase: 'Succeeded',
                nodes: {
                    'node-a': {id: 'node-a', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step A', outputs: {artifacts: [{name: 'main-logs'}]}},
                    'node-b': {id: 'node-b', phase: 'Succeeded', type: 'Pod', templateName: 'step', displayName: 'Step B', outputs: {artifacts: [{name: 'main-logs'}]}}
                }
            }
        } as unknown as Workflow;
        const getSpy = jest.spyOn(service, 'get').mockResolvedValue(persistedWorkflow);
        jest.spyOn(service, 'getContainerLogsFromArtifact').mockImplementation((_wf, nodeId) =>
            of({content: `from artifact ${nodeId}`, podName: nodeId === 'node-a' ? 'Step A' : 'Step B'})
        );
        const getClusterLogs = jest.spyOn(service, 'getContainerLogsFromCluster').mockReturnValue(of({content: 'from cluster', podName: 'test-pod'}));

        const entries = await firstValueFrom(service.getContainerLogs(persistedWorkflow, '', undefined, 'main', '', false).pipe(toArray()));

        expect(entries.map(e => e.content)).toEqual(['from artifact node-a', 'from artifact node-b']);
        // the workflow is not in the cluster: no live lookup, no live pod logs
        expect(getSpy).not.toHaveBeenCalled();
        expect(getClusterLogs).not.toHaveBeenCalled();
    });

});
