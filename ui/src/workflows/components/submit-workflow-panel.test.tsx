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
