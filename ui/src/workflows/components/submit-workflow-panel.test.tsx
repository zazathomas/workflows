import {fireEvent, render, waitFor} from '@testing-library/react';
import {createMemoryHistory} from 'history';
import * as React from 'react';

import {Context} from '../../shared/context';
import {PARAMETER_SOURCES_ANNOTATION} from '../../shared/parameter-sources';
import {RunActionContext} from '../../shared/run-action-context';
import {ACTION_MARKER_ANNOTATION} from '../../shared/run-actions';
import {services} from '../../shared/services';
import {SubmitWorkflowPanel} from './submit-workflow-panel';

describe('SubmitWorkflowPanel', () => {
    it.each([false, true])('shows parameter descriptions on the submit form (dynamic sources: %s)', dynamic => {
        const history = createMemoryHistory();
        const context = {navigation: {goto: jest.fn()}, popup: {}, notifications: {}, history} as any;
        const load = jest.spyOn(services.parameterOptions, 'get').mockResolvedValue([]);
        const {getByText, getByLabelText} = render(
            <Context.Provider value={context}>
                <SubmitWorkflowPanel
                    kind='WorkflowTemplate'
                    namespace='argo'
                    name='example'
                    entrypoint='main'
                    templates={[]}
                    workflowParameters={[{name: 'region', description: 'Choose the region for this run.'}]}
                    templateAnnotations={dynamic ? {[PARAMETER_SOURCES_ANNOTATION]: JSON.stringify({region: {url: 'https://catalog.example.com/regions'}})} : undefined}
                    history={history}
                />
            </Context.Provider>
        );
        const description = getByText('Choose the region for this run.');
        expect(description).toBeVisible();
        expect(getByLabelText('region (required)').getAttribute('aria-describedby')).toBe(description.id);
        load.mockRestore();
    });

    it('shows the target namespace without repeating parameter values in the review', () => {
        const history = createMemoryHistory();
        const context = {navigation: {goto: jest.fn()}, popup: {}, notifications: {}, history} as any;
        const {getByRole, getByText} = render(
            <Context.Provider value={context}>
                <SubmitWorkflowPanel
                    kind='WorkflowTemplate'
                    namespace='argo'
                    name='example'
                    entrypoint='main'
                    templates={[]}
                    workflowParameters={[{name: 'token', value: 'sensitive-value'}]}
                    history={history}
                />
            </Context.Provider>
        );
        const review = getByRole('group', {name: 'Submission summary'});
        expect(review).toHaveTextContent('Target namespace: argo');
        expect(review).toHaveTextContent('token');
        expect(review).not.toHaveTextContent('sensitive-value');
        expect(getByText('Run job', {selector: 'button'})).toBeInTheDocument();
    });

    it('copies an opted-in Job marker to the Run and registers the result for monitoring', async () => {
        const history = createMemoryHistory();
        const context = {navigation: {goto: jest.fn()}, popup: {}, notifications: {}, history} as any;
        const track = jest.fn();
        const submitted = {metadata: {namespace: 'argo', name: 'example-123', uid: 'uid-123'}} as any;
        const submit = jest.spyOn(services.workflows, 'submit').mockResolvedValue(submitted);
        const {getByRole} = render(
            <Context.Provider value={context}>
                <RunActionContext.Provider value={{track}}>
                    <SubmitWorkflowPanel
                        kind='WorkflowTemplate'
                        namespace='argo'
                        name='example'
                        entrypoint='main'
                        templates={[]}
                        workflowParameters={[]}
                        templateAnnotations={{[ACTION_MARKER_ANNOTATION]: 'NEEDS_USER_ACTION:'}}
                        history={history}
                    />
                </RunActionContext.Provider>
            </Context.Provider>
        );
        fireEvent.click(getByRole('button', {name: 'Run job'}));
        await waitFor(() =>
            expect(track).toHaveBeenCalledWith(
                expect.objectContaining({metadata: expect.objectContaining({annotations: expect.objectContaining({[ACTION_MARKER_ANNOTATION]: 'NEEDS_USER_ACTION:'})})})
            )
        );
        expect(submit).toHaveBeenCalledWith(
            'WorkflowTemplate',
            'example',
            'argo',
            expect.objectContaining({annotations: 'workflows-ui-action-marker=NEEDS_USER_ACTION:,workflows-ui-action-container=main'})
        );
        expect(context.navigation.goto).toHaveBeenCalledWith('/workflows/argo/example-123');
        submit.mockRestore();
    });

    it('renders the survey form and passes the answers and run message as parameters', async () => {
        const history = createMemoryHistory();
        const context = {navigation: {goto: jest.fn()}, popup: {}, notifications: {}, history} as any;
        const submitted = {metadata: {namespace: 'argo', name: 'example-123', uid: 'uid-123'}} as any;
        const submit = jest.spyOn(services.workflows, 'submit').mockResolvedValue(submitted);
        const {container, getByLabelText, getByRole} = render(
            <Context.Provider value={context}>
                <SubmitWorkflowPanel
                    kind='WorkflowTemplate'
                    namespace='argo'
                    name='example'
                    entrypoint='main'
                    templates={[]}
                    workflowParameters={[{name: 'environment', value: 'dev'}]}
                    templateAnnotations={{
                        'workflows.argoproj.io/survey': JSON.stringify([
                            {name: 'environment', type: 'select', required: true, options: ['dev', 'prod']},
                            {name: 'replicas', type: 'number', default: '3'}
                        ])
                    }}
                    history={history}
                />
            </Context.Provider>
        );

        // the survey question is shown with its declared type, and the covered
        // template parameter is no longer rendered as a raw parameter input
        expect(getByRole('combobox', {name: /environment/i})).toBeInTheDocument();
        expect((container.querySelector('#parameter-environment-0') as HTMLElement) || null).toBeNull();

        // the answers replace the covered template parameter and use declared defaults
        fireEvent.change(getByRole('combobox', {name: /environment/i}), {target: {value: 'prod'}});
        fireEvent.change(getByLabelText(/replicas/i), {target: {value: '5'}});
        fireEvent.change(getByLabelText('Message (optional)'), {target: {value: 'nightly deploy, tickets 123'}});
        fireEvent.click(getByRole('button', {name: 'Run job'}));

        await waitFor(() => expect(submit).toHaveBeenCalled());
        const options = submit.mock.calls[0][3];
        // the survey answers override the template parameter defaults
        expect(options.parameters).toEqual(expect.arrayContaining(['environment=prod', 'replicas=5']));
        expect(options.parameters).not.toContain('environment=dev');
        // commas in the message are sanitized so the annotations option stays a k=v list
        expect(options.annotations).toBe('workflows.argoproj.io/run-message=nightly deploy tickets 123');
        submit.mockRestore();
    });

    it('disables the run button while a required survey answer is missing', () => {
        const history = createMemoryHistory();
        const context = {navigation: {goto: jest.fn()}, popup: {}, notifications: {}, history} as any;
        const {getByRole, getByText} = render(
            <Context.Provider value={context}>
                <SubmitWorkflowPanel
                    kind='WorkflowTemplate'
                    namespace='argo'
                    name='example'
                    entrypoint='main'
                    templates={[]}
                    workflowParameters={[]}
                    templateAnnotations={{
                        'workflows.argoproj.io/survey': JSON.stringify([{name: 'environment', type: 'select', required: true, options: ['dev', 'prod']}])
                    }}
                    history={history}
                />
            </Context.Provider>
        );
        expect(getByRole('button', {name: 'Run job'})).toBeDisabled();
        expect(getByText('environment is required')).toBeInTheDocument();
    });

    it('hides the entrypoint until advanced configuration is enabled', () => {
        const history = createMemoryHistory();
        const context = {
            navigation: {goto: jest.fn()},
            popup: {},
            notifications: {},
            history
        } as any;

        const {getByLabelText, getByText, queryByText} = render(
            <Context.Provider value={context}>
                <SubmitWorkflowPanel
                    kind='WorkflowTemplate'
                    namespace='argo'
                    name='example'
                    entrypoint='main'
                    templates={[{name: 'main', inputs: {parameters: []}} as any]}
                    workflowParameters={[]}
                    history={history}
                />
            </Context.Provider>
        );

        expect(queryByText('Entrypoint')).not.toBeInTheDocument();
        const advancedConfiguration = getByLabelText('Advanced configuration');
        fireEvent.click(advancedConfiguration);
        const entrypoint = getByText('Entrypoint');
        expect(entrypoint).toBeInTheDocument();
        expect(advancedConfiguration.compareDocumentPosition(entrypoint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
});
