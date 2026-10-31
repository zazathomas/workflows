import {SlidingPanel, SlidingPanelProps} from 'argo-ui/src/components/sliding-panel/sliding-panel';
import * as React from 'react';
import {useEffect, useRef} from 'react';

import './accessible-sliding-panel.scss';

export function AccessibleSlidingPanel(props: SlidingPanelProps & {closeLabel?: string}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const wasShownRef = useRef(false);

    if (props.isShown && !wasShownRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
    }

    useEffect(() => {
        if (props.isShown) {
            const panel = containerRef.current?.querySelector<HTMLElement>('.sliding-panel__wrapper');
            panel?.setAttribute('role', 'dialog');
            panel?.setAttribute('aria-modal', 'true');
            panel?.setAttribute('aria-label', props.closeLabel ? props.closeLabel.replace(/^Close\s+/i, '') : 'Panel');
            const closeButton = containerRef.current?.querySelector<HTMLButtonElement>('.sliding-panel__close');
            closeButton?.removeAttribute('aria-hidden');
            closeButton?.setAttribute('aria-label', props.closeLabel || 'Close panel');
            closeButton?.setAttribute('type', 'button');
            closeButton?.focus();
        } else if (wasShownRef.current && previousFocusRef.current && document.contains(previousFocusRef.current)) {
            previousFocusRef.current.focus();
        }

        wasShownRef.current = !!props.isShown;
    }, [props.isShown, props.closeLabel]);

    useEffect(() => {
        if (!props.isShown) {
            return;
        }

        // Hide the rest of the application from assistive technology while the
        // modal is open. Preserve pre-existing attributes so nested UI state is
        // restored when the panel closes.
        const hiddenSiblings: Array<{element: HTMLElement; inert: boolean; ariaHidden: string | null}> = [];
        let current: HTMLElement | null = containerRef.current;
        while (current && current.parentElement) {
            const parent: HTMLElement = current.parentElement;
            Array.from(parent.children).forEach(sibling => {
                if (sibling === current || !(sibling instanceof HTMLElement)) return;
                hiddenSiblings.push({element: sibling, inert: sibling.hasAttribute('inert'), ariaHidden: sibling.getAttribute('aria-hidden')});
                sibling.setAttribute('inert', '');
                sibling.setAttribute('aria-hidden', 'true');
            });
            if (parent === document.body) break;
            current = parent;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                props.onClose?.();
                return;
            }
            if (event.key !== 'Tab') {
                return;
            }

            const focusableElements = Array.from(
                containerRef.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ) || []
            ).filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');

            if (focusableElements.length === 0) {
                event.preventDefault();
                return;
            }

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            if (event.shiftKey && document.activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
            } else if (!event.shiftKey && document.activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            hiddenSiblings.forEach(({element, inert, ariaHidden}) => {
                if (!inert) element.removeAttribute('inert');
                if (ariaHidden === null) element.removeAttribute('aria-hidden');
                else element.setAttribute('aria-hidden', ariaHidden);
            });
        };
    }, [props.isShown, props.onClose]);

    return (
        <div ref={containerRef}>
            <SlidingPanel {...props} />
        </div>
    );
}
