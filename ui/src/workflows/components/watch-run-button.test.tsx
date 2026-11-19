import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import * as React from 'react';

import {Workflow} from '../../shared/models';
import {isTerminalPhase, WatchRunButton} from './watch-run-button';

function workflow(uid: string, phase: string): Workflow {
    return {metadata: {uid, name: 'wf'}, status: {phase}} as unknown as Workflow;
}

describe('isTerminalPhase', () => {
    it('recognizes terminal phases', () => {
        expect(isTerminalPhase('Succeeded')).toBe(true);
        expect(isTerminalPhase('Failed')).toBe(true);
        expect(isTerminalPhase('Error')).toBe(true);
        expect(isTerminalPhase('Running')).toBe(false);
        expect(isTerminalPhase(undefined)).toBe(false);
    });
});

describe('WatchRunButton', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('does not enable watching for a finished run', async () => {
        const permission = jest.fn().mockResolvedValue('granted');
        (global as any).Notification = {permission: 'granted', requestPermission: permission};
        render(<WatchRunButton workflow={workflow('uid-1', 'Succeeded')} />);
        fireEvent.click(screen.getByRole('button', {name: /watch/i}));
        await waitFor(() => expect(permission).not.toHaveBeenCalled());
        expect(localStorage.getItem('watch-run-uids')).toBeNull();
    });

    it('watches a running run and notifies when it finishes', async () => {
        const notification = jest.fn();
        (global as any).Notification = {permission: 'granted', requestPermission: jest.fn()};
        (global as any).Notification = function MockNotification(title: string, options?: any) {
            notification(title, options);
        } as any;
        (global as any).Notification.permission = 'granted';
        (global as any).Notification.requestPermission = jest.fn();

        const {rerender} = render(<WatchRunButton workflow={workflow('uid-2', 'Running')} />);
        fireEvent.click(screen.getByRole('button', {name: /watch/i}));
        expect(localStorage.getItem('watch-run-uids')).toContain('uid-2');

        rerender(<WatchRunButton workflow={workflow('uid-2', 'Succeeded')} />);
        await waitFor(() => expect(notification).toHaveBeenCalledWith('Run wf succeeded', expect.anything()));
        // the watch is cleared after firing
        expect(localStorage.getItem('watch-run-uids')).toBe('[]');
    });
});
