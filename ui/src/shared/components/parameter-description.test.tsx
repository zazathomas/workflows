import {fireEvent, render, waitFor} from '@testing-library/react';
import React from 'react';

import {Parameter} from '../models';
import {DynamicParametersInput} from './dynamic-parameters-input';
import {ParametersInput} from './parameters-input';

const described: Parameter = {name: 'region', value: 'eu-central-1', description: 'Where the run executes.'};

describe('parameter descriptions', () => {
    it('stays collapsed behind a labelled question mark until requested', () => {
        const {getByRole, queryByText} = render(<ParametersInput parameters={[described]} onChange={() => undefined} />);

        expect(queryByText('Where the run executes.')).not.toBeVisible();
        const toggle = getByRole('button', {name: 'Show description for region'});
        expect(toggle).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(toggle);

        expect(queryByText('Where the run executes.')).toBeVisible();
        const hide = getByRole('button', {name: 'Hide description for region'});
        expect(hide).toHaveAttribute('aria-expanded', 'true');
    });

    it('offers the same control for parameters backed by a dynamic source', async () => {
        const {getByRole, queryByText} = render(
            <DynamicParametersInput namespace='argo' templateKind='WorkflowTemplate' templateName='sample' parameters={[described]} sources={{}} onChange={() => undefined} />
        );

        await waitFor(() => expect(queryByText('Where the run executes.')).not.toBeVisible());
        fireEvent.click(getByRole('button', {name: 'Show description for region'}));
        expect(queryByText('Where the run executes.')).toBeVisible();
    });

    it('renders nothing when a parameter has no description', () => {
        const {queryByRole} = render(<ParametersInput parameters={[{name: 'plain'}]} onChange={() => undefined} />);
        expect(queryByRole('button', {name: /description for plain/})).not.toBeInTheDocument();
    });
});
