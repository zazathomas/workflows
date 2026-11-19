import {History} from 'history';
import React, {useContext, useEffect, useMemo, useRef, useState} from 'react';

import {ANNOTATION_RUN_MESSAGE} from '../../shared/annotations';
import {uiUrl} from '../../shared/base';
import {Select} from '../../shared/components/accessible-select';
import {ArtifactsInput, ArtifactUploadResponse} from '../../shared/components/artifacts-input';
import {DynamicParametersInput} from '../../shared/components/dynamic-parameters-input';
import {ErrorNotice} from '../../shared/components/error-notice';
import {getValueFromParameter, ParametersInput} from '../../shared/components/parameters-input';
import {SurveyForm} from '../../shared/components/survey-form';
import {TagsInput} from '../../shared/components/tags-input/tags-input';
import {TextInput} from '../../shared/components/text-input';
import {Context} from '../../shared/context';
import {getWorkflowParametersFromQuery} from '../../shared/get_workflow_params';
import {Artifact, Parameter, Template} from '../../shared/models';
import {parseParameterSources} from '../../shared/parameter-sources';
import {RunActionContext} from '../../shared/run-action-context';
import {ACTION_CONTAINER_ANNOTATION, ACTION_MARKER_ANNOTATION, configFromAnnotations, submitAnnotations} from '../../shared/run-actions';
import {services} from '../../shared/services';
import {parseSurvey, promptedQuestions, surveyDefaults, surveyIsValid} from '../../shared/survey';

import './submit-workflow-panel.scss';

interface Props {
    kind: 'ClusterWorkflowTemplate' | 'WorkflowTemplate';
    namespace: string;
    onNamespaceChange?: (namespace: string) => void;
    name: string;
    entrypoint: string;
    templates: Template[];
    workflowParameters: Parameter[];
    workflowArtifacts?: Artifact[];
    templateAnnotations?: Record<string, string>;
    history: History;
}

const workflowEntrypoint = '<default>';
const defaultTemplate: Template = {
    name: workflowEntrypoint,
    inputs: {
        parameters: []
    }
};

export function SubmitWorkflowPanel(props: Props) {
    const {navigation} = useContext(Context);
    const runActions = useContext(RunActionContext);
    const [entrypoint, setEntrypoint] = useState(props.entrypoint || workflowEntrypoint);
    const [showAdvancedConfiguration, setShowAdvancedConfiguration] = useState(false);
    const [parameters, setParameters] = useState<Parameter[]>([]);
    const [workflowParameters, setWorkflowParameters] = useState<Parameter[]>(JSON.parse(JSON.stringify(props.workflowParameters)));
    const [labels, setLabels] = useState(['submit-from-ui=true']);
    const [error, setError] = useState<Error>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [uploadedArtifacts, setUploadedArtifacts] = useState<Record<string, ArtifactUploadResponse>>({});
    const [uploadingArtifacts, setUploadingArtifacts] = useState<Set<string>>(new Set());
    const [message, setMessage] = useState('');
    const errorRef = useRef<HTMLDivElement>(null);
    const parameterSources = useMemo(() => parseParameterSources(props.templateAnnotations), [props.templateAnnotations]);
    // the launch form ("survey") declared on the Job; answers become parameters
    const surveyQuestions = useMemo(() => parseSurvey(props.templateAnnotations), [props.templateAnnotations]);
    const askedQuestions = useMemo(() => promptedQuestions(surveyQuestions), [surveyQuestions]);
    const [surveyAnswers, setSurveyAnswers] = useState<Record<string, string>>(() => surveyDefaults(surveyQuestions));
    const surveyValid = useMemo(() => surveyIsValid(surveyQuestions, surveyAnswers), [surveyQuestions, surveyAnswers]);

    useEffect(() => {
        if (error) {
            errorRef.current?.focus();
        }
    }, [error]);

    const handleArtifactUploadStart = (artifactName: string) => {
        setUploadingArtifacts(prev => new Set(prev).add(artifactName));
    };

    const handleArtifactUpload = (artifactName: string, response: ArtifactUploadResponse) => {
        setUploadedArtifacts(prev => ({...prev, [artifactName]: response}));
        setUploadingArtifacts(prev => {
            const next = new Set(prev);
            next.delete(artifactName);
            return next;
        });
    };

    const handleArtifactUploadError = (artifactName: string, err: Error) => {
        setError(err);
        // Clear the upload-in-progress marker on failure too, otherwise the Submit
        // button stays disabled ("Uploading...") until the page is reloaded.
        setUploadingArtifacts(prev => {
            const next = new Set(prev);
            next.delete(artifactName);
            return next;
        });
    };

    useEffect(() => {
        const templatePropertiesInQuery = getWorkflowParametersFromQuery(props.history);
        // Get the user arguments from the query params
        const updatedParams = workflowParameters.map(param => ({
            ...param,
            value: templatePropertiesInQuery[param.name] || param.value
        }));
        setWorkflowParameters(updatedParams);
    }, [props.history, setWorkflowParameters]);

    const templates = useMemo(() => {
        return [defaultTemplate].concat(props.templates);
    }, [props.templates]);

    const templateOptions = useMemo(() => {
        return templates.map(t => ({
            value: t.name,
            title: t.name
        }));
    }, [templates]);

    async function submit() {
        if (isSubmitting || uploadingArtifacts.size > 0) {
            return;
        }
        if (!surveyValid) {
            setError(new Error('Answer the required form questions before running.'));
            return;
        }
        setIsSubmitting(true);
        try {
            // Build artifacts array from uploaded artifacts
            // Format: name=key (the key only, not the full S3 URL)
            const artifactOverrides = Object.entries(uploadedArtifacts).map(([name, response]) => {
                return `${name}=${response.key}`;
            });

            const actionConfig = configFromAnnotations(props.templateAnnotations);
            if (props.templateAnnotations?.[ACTION_MARKER_ANNOTATION] && !actionConfig) {
                throw new Error('Invalid run action marker or container in the Job template.');
            }
            // survey answers override the template's parameter defaults
            const answered = new Set(askedQuestions.map(question => question.name));
            const answerParameters = askedQuestions
                .filter(question => surveyAnswers[question.name] !== undefined && surveyAnswers[question.name] !== '')
                .map(question => `${question.name}=${surveyAnswers[question.name]}`);
            // the annotations option is a comma-separated k=v list, so commas
            // and newlines cannot be stored in the run message
            const trimmedMessage = message
                .trim()
                .replace(/[\r\n,]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const messageAnnotation = trimmedMessage ? `${ANNOTATION_RUN_MESSAGE}=${trimmedMessage}` : undefined;
            const actionAnnotations = actionConfig ? submitAnnotations(actionConfig) : undefined;
            const annotations = [messageAnnotation, actionAnnotations].filter(Boolean).join(',') || undefined;
            const submitted = await services.workflows.submit(props.kind, props.name, props.namespace, {
                entryPoint: entrypoint === workflowEntrypoint ? null : entrypoint,
                parameters: [
                    ...workflowParameters.filter(p => !answered.has(p.name) && getValueFromParameter(p) !== undefined).map(p => p.name + '=' + getValueFromParameter(p)),
                    ...answerParameters,
                    ...parameters.filter(p => getValueFromParameter(p) !== undefined).map(p => p.name + '=' + getValueFromParameter(p))
                ],
                labels: labels.join(','),
                annotations,
                artifacts: artifactOverrides.length > 0 ? artifactOverrides : undefined
            });
            if (actionConfig) {
                runActions?.track({
                    ...submitted,
                    metadata: {
                        ...submitted.metadata,
                        annotations: {
                            ...submitted.metadata.annotations,
                            [ACTION_MARKER_ANNOTATION]: actionConfig.marker,
                            [ACTION_CONTAINER_ANNOTATION]: actionConfig.container
                        }
                    }
                });
            }
            navigation.goto(uiUrl(`workflows/${submitted.metadata.namespace}/${submitted.metadata.name}`));
        } catch (err) {
            setError(err);
            setIsSubmitting(false);
        }
    }

    return (
        <>
            <h4>Run job</h4>
            <h5>
                {props.namespace}/{props.name}
            </h5>
            {error && (
                <div ref={errorRef} tabIndex={-1}>
                    <ErrorNotice error={error} />
                </div>
            )}
            <div className='white-box'>
                {props.onNamespaceChange && (
                    <div key='namespace' style={{marginBottom: 25}}>
                        <label htmlFor='submit-workflow-namespace'>Namespace</label>
                        <TextInput id='submit-workflow-namespace' value={props.namespace} onChange={props.onNamespaceChange} />
                    </div>
                )}
                <div key='message' style={{marginBottom: 25}}>
                    <label htmlFor='submit-workflow-message'>Message (optional)</label>
                    <TextInput id='submit-workflow-message' placeholder='A note stored with this run' value={message} onChange={setMessage} />
                    <small>The message is shown on the run header and in lists, like a commit message.</small>
                </div>
                {askedQuestions.length > 0 && (
                    <fieldset key='survey' style={{marginBottom: 25, border: 0, padding: 0}}>
                        <legend>Form</legend>
                        <p>Answer the form questions; your answers are passed to the job as parameters.</p>
                        <SurveyForm questions={askedQuestions} answers={surveyAnswers} onChange={setSurveyAnswers} />
                    </fieldset>
                )}
                <fieldset key='parameters' style={{marginBottom: 25, border: 0, padding: 0}}>
                    <legend>Parameters</legend>
                    <p>Values shown initially come from the template or the submission link. Review them before running.</p>
                    {(() => {
                        // parameters covered by a form question are asked there instead
                        const surveyedParameters = workflowParameters.filter(p => !askedQuestions.some(question => question.name === p.name));
                        return (
                            surveyedParameters.length > 0 &&
                            (Object.keys(parameterSources).length > 0 ? (
                                <DynamicParametersInput
                                    namespace={props.namespace}
                                    templateKind={props.kind}
                                    templateName={props.name}
                                    parameters={surveyedParameters}
                                    sources={parameterSources}
                                    onChange={setWorkflowParameters}
                                />
                            ) : (
                                <ParametersInput parameters={surveyedParameters} onChange={setWorkflowParameters} />
                            ))
                        );
                    })()}
                    {parameters.length > 0 && <ParametersInput parameters={parameters} onChange={setParameters} />}
                    {workflowParameters.length === 0 && parameters.length === 0 ? (
                        <>
                            <br />
                            <span>No parameters</span>
                        </>
                    ) : (
                        <></>
                    )}
                </fieldset>
                {props.workflowArtifacts && props.workflowArtifacts.length > 0 && (
                    <div key='artifacts' style={{marginBottom: 25}}>
                        <label>Input Artifacts</label>
                        {props.workflowArtifacts.map(artifact => (
                            <div key={artifact.name} style={{marginTop: 10}}>
                                <label style={{fontWeight: 'normal', fontSize: '0.9em'}}>{artifact.name}</label>
                                <ArtifactsInput
                                    namespace={props.namespace}
                                    workflowTemplateName={props.name}
                                    artifactName={artifact.name}
                                    onUploadStart={() => handleArtifactUploadStart(artifact.name)}
                                    onUploadComplete={response => handleArtifactUpload(artifact.name, response)}
                                    onError={err => handleArtifactUploadError(artifact.name, err)}
                                />
                                {uploadedArtifacts[artifact.name] && <small style={{color: 'green'}}>✓ Uploaded: {uploadedArtifacts[artifact.name].key}</small>}
                            </div>
                        ))}
                    </div>
                )}
                <div key='labels' style={{marginBottom: 25}}>
                    <label htmlFor='submit-workflow-labels'>Labels</label>
                    <TagsInput id='submit-workflow-labels' tags={labels} onChange={setLabels} />
                </div>
                <div key='advanced' className='submit-workflow-panel__advanced'>
                    <input
                        id='submit-workflow-advanced-configuration'
                        type='checkbox'
                        checked={showAdvancedConfiguration}
                        onChange={event => setShowAdvancedConfiguration(event.target.checked)}
                    />
                    <label htmlFor='submit-workflow-advanced-configuration'>Advanced configuration</label>
                </div>
                {showAdvancedConfiguration && (
                    <div key='entrypoint' title='Entrypoint' style={{marginBottom: 25}}>
                        <label htmlFor='submit-workflow-entrypoint'>Entrypoint</label>
                        <Select
                            id='submit-workflow-entrypoint'
                            value={entrypoint}
                            options={templateOptions}
                            onChange={selected => {
                                const selectedTemp = templates.find(t => t.name === selected.value);
                                setEntrypoint(selected.value);
                                setParameters(selectedTemp?.inputs?.parameters || []);
                            }}
                        />
                    </div>
                )}
                <div key='review' className='submit-workflow-panel__review' role='group' aria-label='Submission summary'>
                    <h4>Review</h4>
                    <p>Template: {props.name}</p>
                    <p>Template type: {props.kind === 'ClusterWorkflowTemplate' ? 'Cluster workflow template' : 'Workflow template'}</p>
                    <p>Target namespace: {props.namespace}</p>
                    {workflowParameters.length > 0 && <p>Parameters: {workflowParameters.map(parameter => parameter.name).join(', ')}. Review values above before running.</p>}
                    <p>Labels: {labels.join(', ')}</p>
                </div>
                <span role='status' className='modern-visually-hidden'>
                    {isSubmitting ? 'Submitting workflow' : uploadingArtifacts.size > 0 ? 'Uploading artifacts' : ''}
                </span>
                <div key='submit'>
                    <button
                        onClick={submit}
                        className='argo-button argo-button--base'
                        disabled={isSubmitting || uploadingArtifacts.size > 0 || !surveyValid}
                        aria-busy={isSubmitting}>
                        <i className='fa fa-plus' aria-hidden='true' /> {isSubmitting ? 'Starting...' : uploadingArtifacts.size > 0 ? 'Uploading...' : 'Run job'}
                    </button>
                </div>
            </div>
        </>
    );
}
