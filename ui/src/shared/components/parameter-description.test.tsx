import {render} from '@testing-library/react';
import React from 'react';

import {Parameter} from '../models';
import {DynamicParametersInput} from './dynamic-parameters-input';
import {ParametersInput} from './parameters-input';

const described: Parameter = {name: 'region', value: 'eu-central-1', description: 'Where the run executes.'};

describe('parameter descriptions', () => {
    it('shows the description below a regular parameter', () => {
        const {getByText, getByLabelText} = render(<ParametersInput parameters={[described]} onChange={() => undefined} />);
        const description = getByText('Where the run executes.');
        expect(description).toBeVisible();
        expect(getByLabelText('region').getAttribute('aria-describedby')).toBe(description.id);
    });

    it('shows the description for parameters backed by a dynamic source', () => {
        const {getByText, getByLabelText} = render(
            <DynamicParametersInput namespace='argo' templateKind='WorkflowTemplate' templateName='sample' parameters={[described]} sources={{}} onChange={() => undefined} />
        );
        const description = getByText('Where the run executes.');
        expect(description).toBeVisible();
        expect(getByLabelText('region').getAttribute('aria-describedby')).toBe(description.id);
    });

    it('renders nothing when a parameter has no description', () => {
        const {container} = render(<ParametersInput parameters={[{name: 'plain'}]} onChange={() => undefined} />);
        expect(container.querySelector('.parameter-description')).not.toBeInTheDocument();
    });
});
