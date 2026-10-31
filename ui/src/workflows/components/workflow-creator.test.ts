import {exampleClusterWorkflowTemplate, exampleWorkflowTemplate} from '../../shared/examples';
import {workflowFromTemplate} from './workflow-creator';

test('full editor retains namespace template scope', () => {
    const template = exampleWorkflowTemplate('argo');
    const workflow = workflowFromTemplate('argo', {kind: 'WorkflowTemplate', template});
    expect(workflow.spec.workflowTemplateRef).toEqual({name: template.metadata.name});
    expect(workflow.metadata.labels['workflows.argoproj.io/workflow-template']).toBe(template.metadata.name);
});

test('full editor retains cluster template scope and target namespace', () => {
    const template = exampleClusterWorkflowTemplate();
    const workflow = workflowFromTemplate('argo', {kind: 'ClusterWorkflowTemplate', template});
    expect(workflow.spec.workflowTemplateRef).toEqual({name: template.metadata.name, clusterScope: true});
    expect(workflow.metadata.namespace).toBe('argo');
    expect(workflow.metadata.labels['workflows.argoproj.io/cluster-workflow-template']).toBe(template.metadata.name);
});
