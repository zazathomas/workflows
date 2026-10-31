import {fireEvent, render} from '@testing-library/react';
import * as React from 'react';

import {Workflow} from '../../../shared/models';
import {WorkflowLabels} from './workflow-labels';

test('workflow label filters are named buttons and support keyboard activation', () => {
    const onChange = jest.fn();
    const workflow = {metadata: {uid: 'id', labels: {team: 'platform'}}} as unknown as Workflow;
    const {getByRole} = render(<WorkflowLabels workflow={workflow} onChange={onChange} />);
    const button = getByRole('button', {name: 'List workflows labelled with team=platform'});
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith('team', 'platform');
});
