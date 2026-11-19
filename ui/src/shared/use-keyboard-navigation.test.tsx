import {fireEvent, render} from '@testing-library/react';
import * as React from 'react';

import {SHORTCUTS, useKeyboardNavigation} from './use-keyboard-navigation';

function Probe({onShowHelp, navigate}: {onShowHelp: () => void; navigate?: (path: string) => void}) {
    useKeyboardNavigation(onShowHelp, navigate);
    return (
        <div>
            <input aria-label='Search runs' placeholder='Search runs…' />
        </div>
    );
}

describe('keyboard navigation', () => {
    it('shows the shortcut sheet on ?', () => {
        const onShowHelp = jest.fn();
        render(<Probe onShowHelp={onShowHelp} />);
        fireEvent.keyDown(window, {key: '?'});
        expect(onShowHelp).toHaveBeenCalledTimes(1);
    });

    it('focuses the search input on /', () => {
        render(<Probe onShowHelp={jest.fn()} />);
        const input = document.querySelector('input');
        input.blur();
        fireEvent.keyDown(window, {key: '/'});
        expect(document.activeElement).toBe(input);
    });

    it('does nothing while typing in an input', () => {
        const onShowHelp = jest.fn();
        const {container} = render(<Probe onShowHelp={onShowHelp} />);
        const input = container.querySelector('input');
        input.focus();
        expect(document.activeElement).toBe(input);
        // The hook checks the event target: a keydown on the focused input
        // is a typing event and must not trigger shortcuts.
        fireEvent.keyDown(input, {key: '?'});
        expect(onShowHelp).not.toHaveBeenCalled();
    });

    it('navigates with g then r', () => {
        const navigate = jest.fn();
        render(<Probe onShowHelp={jest.fn()} navigate={navigate} />);
        fireEvent.keyDown(window, {key: 'g'});
        fireEvent.keyDown(window, {key: 'r'});
        expect(navigate).toHaveBeenCalledWith('/workflows');
    });

    it('g followed by an unmapped key does nothing', () => {
        const navigate = jest.fn();
        render(<Probe onShowHelp={jest.fn()} navigate={navigate} />);
        fireEvent.keyDown(window, {key: 'g'});
        fireEvent.keyDown(window, {key: 'x'});
        expect(navigate).not.toHaveBeenCalled();
    });

    it('navigates to every mapped page key', () => {
        for (const [key, path] of [
            ['o', '/dashboard'],
            ['j', '/workflow-templates'],
            ['a', '/approvals'],
            ['s', '/cron-workflows']
        ] as [string, string][]) {
            const navigate = jest.fn();
            const {unmount} = render(<Probe onShowHelp={jest.fn()} navigate={navigate} />);
            fireEvent.keyDown(window, {key: 'g'});
            fireEvent.keyDown(window, {key});
            expect(navigate).toHaveBeenCalledWith(path);
            unmount();
        }
    });

    it('documents every shortcut in the sheet', () => {
        expect(SHORTCUTS.length).toBeGreaterThanOrEqual(6);
        expect(SHORTCUTS.map(s => s.key)).toEqual(expect.arrayContaining(['g then r', '/', '?']));
    });
});
