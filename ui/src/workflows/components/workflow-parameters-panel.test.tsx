import {fireEvent, render, within} from '@testing-library/react';
import * as React from 'react';

import {WorkflowParametersPanel} from './workflow-parameters-panel';

describe('WorkflowParametersPanel', () => {
    it('previews the first line of multiline values and expands each value independently', () => {
        const {getByText} = render(
            <WorkflowParametersPanel
                parameters={[
                    {name: 'config', value: 'first line\nsecond line\nthird line'},
                    {name: 'notes', value: 'another first line\r\nanother second line'},
                    {name: 'region', value: 'us-west-1'}
                ]}
            />
        );
        const config = getByText('config').closest('.white-box__details-row') as HTMLElement;
        const notes = getByText('notes').closest('.white-box__details-row') as HTMLElement;
        const region = getByText('region').closest('.white-box__details-row') as HTMLElement;
        const configDetails = within(config).getByText('first line…').closest('details');
        const notesDetails = within(notes).getByText('another first line…').closest('details');
        expect(configDetails).not.toHaveAttribute('open');
        expect(notesDetails).not.toHaveAttribute('open');
        expect(within(config).getByText('first line…')).toHaveClass('workflow-parameter-value__preview');
        const fullValue = config.querySelector('pre');
        expect(fullValue).toHaveTextContent('first line second line third line');
        expect(within(region).queryByText('View full value')).not.toBeInTheDocument();
        expect(within(region).getByText('us-west-1')).toBeVisible();

        fireEvent.click(within(config).getByText('View full value'));
        expect(configDetails).toHaveAttribute('open');
        expect(notesDetails).not.toHaveAttribute('open');
        expect(fullValue).toBeVisible();
        fireEvent.click(within(config).getByText('Hide full value'));
        expect(configDetails).not.toHaveAttribute('open');
    });
});
