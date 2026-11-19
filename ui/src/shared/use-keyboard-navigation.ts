import {useEffect} from 'react';

import {uiUrl} from './base';

interface Shortcut {
    key: string;
    description: string;
}

/** The global shortcut sheet, shown with `?`. */
export const SHORTCUTS: Shortcut[] = [
    {key: 'g then o', description: 'Go to Overview'},
    {key: 'g then j', description: 'Go to Jobs'},
    {key: 'g then r', description: 'Go to Runs'},
    {key: 'g then a', description: 'Go to Approvals'},
    {key: 'g then s', description: 'Go to Schedules'},
    {key: '/', description: 'Focus the Runs search'},
    {key: '?', description: 'Show this shortcut sheet'}
];

function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
        return false;
    }
    const tag = element.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
}

/**
 * Keyboard-first navigation (n8n/Temporal pattern): `g` followed by a page
 * key jumps between sections, `/` focuses the Runs search, `?` toggles the
 * shortcut sheet. Shortcuts never fire while typing.
 */
export function useKeyboardNavigation(onShowHelp: () => void, navigate?: (path: string) => void) {
    useEffect(() => {
        let pendingG = false;
        let pendingGTimer: ReturnType<typeof setTimeout>;

        function go(path: string) {
            if (navigate) {
                navigate(uiUrl(path));
            } else {
                window.location.assign(uiUrl(path));
            }
        }

        function onKeyDown(event: KeyboardEvent) {
            if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
                return;
            }
            if (pendingG) {
                pendingG = false;
                clearTimeout(pendingGTimer);
                switch (event.key) {
                    case 'o':
                        event.preventDefault();
                        go('dashboard');
                        return;
                    case 'j':
                        event.preventDefault();
                        go('workflow-templates');
                        return;
                    case 'r':
                        event.preventDefault();
                        go('workflows');
                        return;
                    case 'a':
                        event.preventDefault();
                        go('approvals');
                        return;
                    case 's':
                        event.preventDefault();
                        go('cron-workflows');
                        return;
                    default:
                        return;
                }
            }
            if (event.key === 'g') {
                pendingG = true;
                clearTimeout(pendingGTimer);
                pendingGTimer = setTimeout(() => (pendingG = false), 1200);
                return;
            }
            if (event.key === '?') {
                event.preventDefault();
                onShowHelp();
                return;
            }
            if (event.key === '/') {
                event.preventDefault();
                // Focus the Runs search box wherever it exists.
                const search = document.querySelector<HTMLInputElement>("input[placeholder*='Search'], input[aria-label*='Search']");
                if (search) {
                    search.focus();
                } else {
                    go('workflows');
                }
            }
        }

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            clearTimeout(pendingGTimer);
        };
    }, [onShowHelp, navigate]);
}
