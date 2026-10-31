import {fireEvent, render, waitFor} from '@testing-library/react';
import React from 'react';

import {Parameter} from '../models';
import {services} from '../services';
import {DynamicParametersInput} from './dynamic-parameters-input';

describe('DynamicParametersInput', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('clears dependent values when a parent changes', async () => {
        const parameters: Parameter[] = [
            {name: 'organization', value: 'argoproj'},
            {name: 'repository', value: 'argo-workflows'}
        ];
        const onChange = jest.fn();
        const getOptions = jest.spyOn(services.parameterOptions, 'get').mockResolvedValue([
            {label: 'Argo', value: 'argoproj'},
            {label: 'Other', value: 'other-org'}
        ]);

        const {getByLabelText} = render(
            <DynamicParametersInput
                namespace='argo'
                templateKind='WorkflowTemplate'
                templateName='sample'
                parameters={parameters}
                sources={{
                    organization: {url: 'https://example.test/organizations'},
                    repository: {url: 'https://example.test/{{organization}}/repositories', dependsOn: ['organization']}
                }}
                onChange={onChange}
            />
        );

        await waitFor(() => expect(getOptions).toHaveBeenCalledTimes(2));
        fireEvent.change(getByLabelText('organization'), {target: {value: 'other-org'}});

        expect(onChange).toHaveBeenLastCalledWith([
            {name: 'organization', value: 'other-org'},
            {name: 'repository', value: ''}
        ]);
    });

    it('exposes source failures and leaves a manual input available', async () => {
        jest.spyOn(services.parameterOptions, 'get').mockRejectedValue(new Error('source unavailable'));

        const {findByRole} = render(
            <DynamicParametersInput
                namespace='argo'
                templateKind='WorkflowTemplate'
                templateName='sample'
                parameters={[{name: 'repository'}]}
                sources={{repository: {url: 'https://example.test/repositories'}}}
                onChange={() => undefined}
            />
        );

        expect(await findByRole('alert')).toHaveTextContent('source unavailable');
        expect(await findByRole('textbox')).toBeInTheDocument();
    });
});
