import classNames from 'classnames';
import React, {ReactNode, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import './dropdown.scss';

export interface DropDownProps {
    isMenu?: boolean;
    anchor: JSX.Element | ((opened: boolean) => JSX.Element);
    closeOnInsideClick?: boolean;
    contentClassName?: string;
    children: ReactNode;
}

const FOCUSABLE_SELECTOR = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function DropDown({isMenu, anchor, closeOnInsideClick, contentClassName, children}: DropDownProps) {
    const [opened, setOpened] = useState(false);
    const [left, setLeft] = useState(0);
    const [top, setTop] = useState(0);
    const anchorRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const anchorEl = anchorRef.current;
    const contentEl = contentRef.current;

    function focusAnchor() {
        const trigger = anchorEl?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        trigger?.focus();
    }

    function refreshState() {
        const anchorHeight = anchorEl.offsetHeight + 2;
        const {top: anchorTop, left: anchorLeft} = anchorEl.getBoundingClientRect();
        const newState = {top, left, opened};

        // Set top position
        if (contentEl.offsetHeight + anchorTop + anchorHeight > window.innerHeight) {
            newState.top = anchorTop - contentEl.offsetHeight - 2;
        } else {
            newState.top = anchorTop + anchorHeight;
        }

        // Set left position
        if (contentEl.offsetWidth + anchorLeft > window.innerWidth) {
            newState.left = anchorLeft - contentEl.offsetWidth + anchorEl.offsetWidth;
        } else {
            newState.left = anchorLeft;
        }

        return newState;
    }

    function open() {
        if (!contentEl || !anchorEl) {
            return;
        }

        const newState = refreshState();

        newState.opened = true;
        setOpened(newState.opened);
        setLeft(newState.left);
        setTop(newState.top);
    }

    function close(event: MouseEvent) {
        // Doesn't close when clicked inside the portal area
        if (!closeOnInsideClick && (contentEl.contains(event.target as Node) || anchorEl.contains(event.target as Node))) {
            return;
        }

        setOpened(false);
    }

    useEffect(() => {
        if (!opened) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setOpened(false);
                focusAnchor();
            }
        };
        document.addEventListener('click', close);
        document.addEventListener('keydown', handleKeyDown);

        // Move keyboard focus into the menu so arrow/tab navigation starts there.
        const firstFocusable = contentEl.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (firstFocusable) {
            const timer = window.setTimeout(() => firstFocusable.focus(), 0);
            return () => {
                document.removeEventListener('click', close);
                document.removeEventListener('keydown', handleKeyDown);
                window.clearTimeout(timer);
            };
        }

        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [opened]);

    return (
        <div className='argo-dropdown' ref={anchorRef}>
            <div
                className='argo-dropdown__anchor'
                onClick={event => {
                    if (opened) {
                        setOpened(false);
                    } else {
                        open();
                    }
                    event.stopPropagation();
                }}>
                {typeof anchor === 'function' ? anchor(opened) : anchor}
            </div>
            {createPortal(
                <div className={classNames('argo-dropdown__content', contentClassName, {opened, 'is-menu': isMenu})} style={{top, left}} ref={contentRef}>
                    {children}
                </div>,
                document.body
            )}
        </div>
    );
}
