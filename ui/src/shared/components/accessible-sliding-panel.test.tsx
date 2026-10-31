import {fireEvent, render, waitFor} from '@testing-library/react';
import * as React from 'react';
import {useState} from 'react';

import {AccessibleSlidingPanel} from './accessible-sliding-panel';

function PanelHarness() {
    const [shown, setShown] = useState(false);
    return (
        <>
            <button type='button' onClick={() => setShown(true)}>
                Open panel
            </button>
            <AccessibleSlidingPanel isShown={shown} closeLabel='Close test panel' onClose={() => setShown(false)}>
                <button type='button'>Panel action</button>
            </AccessibleSlidingPanel>
        </>
    );
}

describe('AccessibleSlidingPanel', () => {
    it('labels and focuses the close button, then restores trigger focus', async () => {
        const {getByRole} = render(<PanelHarness />);
        const trigger = getByRole('button', {name: 'Open panel'});

        trigger.focus();
        fireEvent.click(trigger);

        const closeButton = getByRole('button', {name: 'Close test panel'});
        expect(trigger).toHaveAttribute('inert');
        expect(trigger).toHaveAttribute('aria-hidden', 'true');
        expect(getByRole('dialog', {name: 'test panel'})).toHaveAttribute('aria-modal', 'true');
        await waitFor(() => expect(document.activeElement).toBe(closeButton));
        expect(closeButton).not.toHaveAttribute('aria-hidden');

        fireEvent.click(closeButton);
        await waitFor(() => expect(document.activeElement).toBe(trigger));
        expect(trigger).not.toHaveAttribute('inert');
        expect(trigger).not.toHaveAttribute('aria-hidden');
    });
});
