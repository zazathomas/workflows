import classNames from 'classnames';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import './accessible-tabs.scss';

export interface Tab {
    title: string;
    icon?: string;
    badge?: string | number;
    key: string;
    content: React.ReactNode;
    isOnlyContentScrollable?: boolean;
    noPadding?: boolean;
    extraVerticalScrollPadding?: number;
    extraHorizontalScrollPadding?: number;
}

export interface TabsProps {
    navCenter?: boolean;
    fixed?: boolean;
    navTransparent?: boolean;
    tabs: Tab[];
    selectedTabKey?: string;
    onTabSelected?: (tabKey: string) => any;
}

/**
 * Accessible replacement for the argo-ui Tabs. Implements the WAI-ARIA tabs
 * pattern: role=tablist/tab/tabpanel, roving tabindex, arrow-key navigation,
 * and aria-selected/aria-controls wiring.
 */
export function Tabs(props: TabsProps) {
    const [selectedTabKey, setSelectedTabKey] = useState<string | undefined>(props.selectedTabKey);
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    const selectedKey = selectedTabKey || props.tabs[0]?.key;
    const selectedTab = props.tabs.find(tab => tab.key === selectedKey);

    useEffect(() => {
        if (props.selectedTabKey !== undefined) {
            setSelectedTabKey(props.selectedTabKey);
        }
    }, [props.selectedTabKey]);

    function selectTab(tab: Tab) {
        setSelectedTabKey(tab.key);
        if (props.onTabSelected) {
            props.onTabSelected(tab.key);
        }
    }

    function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentKey: string) {
        const keys = props.tabs.map(tab => tab.key);
        const index = keys.indexOf(currentKey);
        let nextIndex: number | undefined;
        switch (event.key) {
            case 'ArrowRight':
                nextIndex = (index + 1) % keys.length;
                break;
            case 'ArrowLeft':
                nextIndex = (index - 1 + keys.length) % keys.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = keys.length - 1;
                break;
        }
        if (nextIndex !== undefined) {
            event.preventDefault();
            const nextKey = keys[nextIndex];
            const nextTab = props.tabs.find(tab => tab.key === nextKey);
            if (nextTab) {
                tabRefs.current[nextKey]?.focus();
                selectTab(nextTab);
            }
        }
    }

    return (
        <div className='tabs'>
            <div className={classNames('tabs__nav', {center: props.navCenter, transparent: props.navTransparent})}>
                <div className={classNames({'fixed-width': props.fixed})}>
                    <div className='tabs__nav-wrapper' role='tablist' aria-label='Tabs'>
                        {props.tabs.map(tab => {
                            const selected = tab.key === selectedKey;
                            return (
                                <button
                                    key={tab.key}
                                    ref={element => {
                                        tabRefs.current[tab.key] = element;
                                    }}
                                    type='button'
                                    role='tab'
                                    id={`tab-${tab.key}`}
                                    aria-selected={selected}
                                    aria-controls={`tabpanel-${tab.key}`}
                                    tabIndex={selected ? 0 : -1}
                                    className={classNames({active: selected})}
                                    onClick={() => selectTab(tab)}
                                    onKeyDown={event => onKeyDown(event, tab.key)}>
                                    {tab.icon && <i className={`fa ${tab.icon}`} aria-hidden='true' />} {tab.title}
                                    {tab.badge && <span className='fa-stack has-badge' data-count={tab.badge} aria-hidden='true' />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
            {selectedTab && (
                <div
                    role='tabpanel'
                    id={`tabpanel-${selectedTab.key}`}
                    aria-labelledby={`tab-${selectedTab.key}`}
                    tabIndex={0}
                    className={classNames('tabs__content', {
                        'tabs__content--scrollable': selectedTab.isOnlyContentScrollable,
                        'tabs__content--no-padding': selectedTab.noPadding
                    })}
                    style={{
                        height: selectedTab.isOnlyContentScrollable ? `calc(100vh - ${selectedTab.extraVerticalScrollPadding || 0}px)` : 'inherit',
                        width: `calc(100% - ${selectedTab.extraHorizontalScrollPadding || 0}px)`
                    }}>
                    {selectedTab.content}
                </div>
            )}
        </div>
    );
}
