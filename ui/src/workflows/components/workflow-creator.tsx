import {History} from 'history';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import {Button} from '../../shared/components/button';
import {ErrorNotice} from '../../shared/components/error-notice';
import {ExampleManifests} from '../../shared/components/example-manifests';
import {SearchableSelect} from '../../shared/components/searchable-select';
import {UploadButton} from '../../shared/components/upload-button';
import {exampleWorkflow} from '../../shared/examples';
import {ClusterWorkflowTemplate, Workflow, WorkflowTemplate} from '../../shared/models';
import * as nsUtils from '../../shared/namespaces';
import {services} from '../../shared/services';
import {useEditableObject} from '../../shared/use-editable-object';
import {SubmitWorkflowPanel} from './submit-workflow-panel';
import {WorkflowEditor} from './workflow-editor';

import './workflow-creator.scss';

type Stage = 'choose-method' | 'submit-workflow' | 'full-editor';
type SelectedTemplate = {kind: 'WorkflowTemplate' | 'ClusterWorkflowTemplate'; template: WorkflowTemplate | ClusterWorkflowTemplate};

export function workflowFromTemplate(namespace: string, selectedTemplate: SelectedTemplate): Workflow {
    return {
        metadata: {
            generateName: selectedTemplate.template.metadata.name + '-',
            namespace,
            labels: {
                [selectedTemplate.kind === 'ClusterWorkflowTemplate' ? 'workflows.argoproj.io/cluster-workflow-template' : 'workflows.argoproj.io/workflow-template']:
                    selectedTemplate.template.metadata.name,
                'submit-from-ui': 'true'
            }
        },
        spec: {
            arguments: selectedTemplate.template.spec.arguments,
            workflowTemplateRef: {name: selectedTemplate.template.metadata.name, ...(selectedTemplate.kind === 'ClusterWorkflowTemplate' ? {clusterScope: true} : {})}
        }
    };
}

export function WorkflowCreator({namespace, onCreate, history}: {namespace: string; onCreate: (workflow: Workflow) => void; history: History}) {
    const [workflowTemplates, setWorkflowTemplates] = useState<WorkflowTemplate[]>();
    const [clusterTemplates, setClusterTemplates] = useState<ClusterWorkflowTemplate[]>();
    const [selectedTemplate, setSelectedTemplate] = useState<SelectedTemplate>();
    const [templateError, setTemplateError] = useState<Error>();
    const [clusterTemplateError, setClusterTemplateError] = useState<Error>();
    const appliedQueryRef = useRef(false);
    const [stage, setStage] = useState<Stage>('choose-method');
    const {object: workflow, setObject: setWorkflow, serialization, lang, setLang} = useEditableObject<Workflow>();
    const [error, setError] = useState<Error>();
    const targetNamespace = selectedTemplate?.kind === 'WorkflowTemplate' ? selectedTemplate.template.metadata.namespace || namespace : namespace;

    useEffect(() => {
        let cancelled = false;
        setWorkflowTemplates(undefined);
        setTemplateError(undefined);
        services.workflowTemplate
            .list(namespace, [])
            .then(list => {
                if (!cancelled) setWorkflowTemplates(list.items || []);
            })
            .catch(err => {
                if (!cancelled) {
                    setWorkflowTemplates([]);
                    setTemplateError(err);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [namespace]);

    useEffect(() => {
        let cancelled = false;
        services.clusterWorkflowTemplate
            .list()
            .then(items => {
                if (!cancelled) setClusterTemplates(items);
            })
            .catch(err => {
                if (!cancelled) {
                    setClusterTemplates([]);
                    setClusterTemplateError(err);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (stage !== 'full-editor') return;
        if (!selectedTemplate) {
            setWorkflow(exampleWorkflow(nsUtils.getNamespaceWithDefault(namespace)));
            return;
        }

        setWorkflow(workflowFromTemplate(targetNamespace, selectedTemplate));
    }, [stage]);

    useEffect(() => {
        if (selectedTemplate) {
            setStage('submit-workflow');
        }
    }, [selectedTemplate]);

    useEffect(() => {
        const queryParams = new URLSearchParams(history.location.search);
        const name = queryParams.get('template');
        const kind = queryParams.get('templateKind') === 'ClusterWorkflowTemplate' ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate';
        const options = kind === 'ClusterWorkflowTemplate' ? clusterTemplates : workflowTemplates;
        if (appliedQueryRef.current || !name || !options) return;
        appliedQueryRef.current = true;
        const template = options.find(item => item.metadata.name === name);
        if (template) setSelectedTemplate({kind, template});
    }, [workflowTemplates, clusterTemplates, history]);

    return (
        <div className='workflow-creator'>
            {stage === 'choose-method' && (
                <section className='workflow-creator__choice' aria-labelledby='submit-workflow-heading'>
                    <div className='workflow-creator__intro'>
                        <div className='workflow-creator__eyebrow'>Start a run</div>
                        <h2 id='submit-workflow-heading'>Run a job</h2>
                        <p>Choose a job for a guided submission, or open the full workflow editor.</p>
                    </div>
                    <ErrorNotice error={error} />
                    <div className='workflow-creator__method'>
                        <label htmlFor='submit-workflow-template'>Job</label>
                        {templateError && (
                            <>
                                <p>Could not load namespace templates.</p>
                                <ErrorNotice error={templateError} />
                            </>
                        )}
                        {clusterTemplateError && (
                            <>
                                <p>Could not load cluster templates.</p>
                                <ErrorNotice error={clusterTemplateError} />
                            </>
                        )}
                        {(!workflowTemplates || !clusterTemplates) && <p className='workflow-creator__status'>Loading templates…</p>}
                        {workflowTemplates && clusterTemplates && workflowTemplates.length === 0 && clusterTemplates.length === 0 && (
                            <p className='workflow-creator__status'>No jobs are available.</p>
                        )}
                        {((workflowTemplates?.length || 0) > 0 || (clusterTemplates?.length || 0) > 0) && (
                            <SearchableSelect
                                id='submit-workflow-template'
                                placeholder='Select a job'
                                options={[
                                    ...(workflowTemplates || []).map(tmpl => ({value: `workflow:${tmpl.metadata.name}`, title: `${tmpl.metadata.name} (namespace)`})),
                                    ...(clusterTemplates || []).map(tmpl => ({value: `cluster:${tmpl.metadata.name}`, title: `${tmpl.metadata.name} (cluster)`}))
                                ]}
                                onChange={option => {
                                    const separator = option.value.indexOf(':');
                                    const scope = option.value.slice(0, separator);
                                    const name = option.value.slice(separator + 1);
                                    const template = (scope === 'cluster' ? clusterTemplates || [] : workflowTemplates || []).find(item => item.metadata.name === name);
                                    if (template) {
                                        appliedQueryRef.current = true;
                                        setSelectedTemplate({kind: scope === 'cluster' ? 'ClusterWorkflowTemplate' : 'WorkflowTemplate', template});
                                    }
                                }}
                            />
                        )}
                    </div>
                    <div className='workflow-creator__separator' aria-hidden='true'>
                        <span>or</span>
                    </div>
                    <button type='button' className='workflow-creator__editor-button' onClick={() => setStage('full-editor')}>
                        <i className='fa fa-code' aria-hidden='true' />
                        <span>
                            <strong>Use the full workflow editor</strong>
                            <small>Edit the complete workflow YAML and advanced options.</small>
                        </span>
                        <i className='fa fa-chevron-right' aria-hidden='true' />
                    </button>
                </section>
            )}
            {stage === 'submit-workflow' && selectedTemplate && (
                <>
                    {selectedTemplate.kind === 'ClusterWorkflowTemplate' && (selectedTemplate.template.spec.arguments?.artifacts || []).length > 0 && (
                        <p role='note'>File uploads are not available for cluster workflow templates. The run will use the template’s configured input artifacts.</p>
                    )}
                    <SubmitWorkflowPanel
                        kind={selectedTemplate.kind}
                        namespace={targetNamespace}
                        name={selectedTemplate.template.metadata.name}
                        entrypoint={selectedTemplate.template.spec.entrypoint}
                        templates={selectedTemplate.template.spec.templates || []}
                        workflowParameters={selectedTemplate.template.spec.arguments?.parameters || []}
                        workflowArtifacts={selectedTemplate.kind === 'WorkflowTemplate' ? selectedTemplate.template.spec.arguments?.artifacts || [] : undefined}
                        templateAnnotations={selectedTemplate.template.metadata.annotations}
                        history={history}
                    />
                    <button type='button' className='workflow-creator__text-button' onClick={() => setStage('full-editor')}>
                        Edit using full workflow options <i className='fa fa-caret-right' aria-hidden='true' />
                    </button>
                </>
            )}
            {stage === 'full-editor' && workflow && (
                <>
                    <div className='workflow-creator__editor-actions'>
                        <UploadButton onUpload={setWorkflow} onError={setError} />
                        <Button
                            icon='plus'
                            onClick={async () => {
                                try {
                                    const newWorkflow = await services.workflows.create(workflow, nsUtils.getNamespaceWithDefault(workflow.metadata.namespace));
                                    onCreate(newWorkflow);
                                } catch (err) {
                                    setError(err);
                                }
                            }}>
                            Create
                        </Button>
                    </div>
                    <ErrorNotice error={error} />
                    <WorkflowEditor workflow={workflow} serialization={serialization} lang={lang} onLangChange={setLang} onChange={setWorkflow} onError={setError} />
                    <div>
                        <ExampleManifests />.
                    </div>
                </>
            )}
        </div>
    );
}
