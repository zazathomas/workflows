import {History} from 'history';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import {uiUrl} from '../base';

import './modern-layout.scss';

type Theme = 'light' | 'dark';

export interface ModernLayoutProps {
    navItems: Array<{path: string; iconClassName: string; title: string; group?: string; activePaths?: string[]}>;
    version?: () => React.ReactElement | null;
    navBarStyle?: {backgroundColor?: string};
    history: History;
    userName?: string;
    children?: React.ReactNode;
}

const THEME_STORAGE_KEY = 'argo-ui-theme';
const NAV_STORAGE_KEY = 'argo-ui-navigation-expanded';

function getInitialTheme(): Theme {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark') {
        return storedTheme;
    }
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
        return 'light';
    }
    return 'dark';
}

function isActiveRoute(locationPath: string, path: string) {
    return locationPath === path || locationPath.startsWith(`${path}/`);
}

function getInitialNavigationState() {
    const stored = window.localStorage.getItem(NAV_STORAGE_KEY);
    if (stored === 'true' || stored === 'false') {
        return stored === 'true';
    }
    return window.matchMedia?.('(min-width: 1280px)').matches ?? false;
}

export function ModernLayout(props: ModernLayoutProps) {
    const [locationPath, setLocationPath] = useState(props.history.location.pathname);
    const [theme, setTheme] = useState<Theme>(getInitialTheme);
    const [expanded, setExpanded] = useState(getInitialNavigationState);
    const [mobileOpen, setMobileOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(() => window.matchMedia?.('(max-width: 640px)').matches ?? false);
    const [hoveredItem, setHoveredItem] = useState<{title: string; top: number}>();
    const mobileMenuRef = useRef<HTMLButtonElement>(null);
    const navRef = useRef<HTMLElement>(null);

    useEffect(() => props.history.listen(location => setLocationPath(location.pathname)), [props.history]);

    useEffect(() => {
        const query = window.matchMedia?.('(max-width: 640px)');
        if (!query) {
            return;
        }
        const update = () => setIsMobile(query.matches);
        update();
        query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
    }, []);

    useEffect(() => {
        window.localStorage.setItem(NAV_STORAGE_KEY, String(expanded));
    }, [expanded]);

    useEffect(() => {
        if (!mobileOpen) {
            return;
        }

        const previouslyFocused = document.activeElement as HTMLElement | null;
        const nav = navRef.current;
        const focusable = nav ? Array.from(nav.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) : [];
        focusable[0]?.focus();

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setMobileOpen(false);
                setExpanded(false);
                return;
            }
            if (event.key !== 'Tab' || focusable.length === 0) {
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previouslyFocused && document.contains(previouslyFocused)) {
                previouslyFocused.focus();
            } else {
                mobileMenuRef.current?.focus();
            }
        };
    }, [mobileOpen]);

    useEffect(() => {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
        document.body.classList.toggle('modern-theme-dark', theme === 'dark');
        return () => document.body.classList.remove('modern-theme-dark');
    }, [theme]);

    const navExpanded = mobileOpen || (!isMobile && expanded);
    const rootClassName = ['modern-layout', `theme-${theme}`, navExpanded ? 'modern-layout--expanded' : ''].filter(Boolean).join(' ');
    const navStyle = props.navBarStyle?.backgroundColor ? ({'--modern-nav-accent': props.navBarStyle.backgroundColor} as React.CSSProperties) : undefined;
    const versionContent = props.version?.();

    function closeMobileNavigation() {
        setMobileOpen(false);
    }

    function toggleNavigation() {
        if (mobileOpen) {
            closeMobileNavigation();
            return;
        }
        setExpanded(value => !value);
    }

    function navigate(path: string) {
        props.history.push(path);
        closeMobileNavigation();
        (document.activeElement as HTMLElement | null)?.blur();
    }

    return (
        <div className={rootClassName}>
            <a
                className='modern-layout__skip-link'
                href='#main-content'
                onClick={event => {
                    event.preventDefault();
                    document.getElementById('main-content')?.focus();
                }}>
                Skip to main content
            </a>
            <button
                ref={mobileMenuRef}
                className='modern-layout__mobile-menu'
                aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={mobileOpen}
                aria-controls='modern-layout-navigation'
                onClick={() => (mobileOpen ? closeMobileNavigation() : setMobileOpen(true))}>
                <i className={`fa ${mobileOpen ? 'fa-times' : 'fa-bars'}`} aria-hidden='true' />
            </button>
            {mobileOpen && <button className='modern-layout__scrim' aria-label='Close navigation' onClick={closeMobileNavigation} />}
            <nav ref={navRef} id='modern-layout-navigation' className='modern-layout__nav' style={navStyle} aria-label='Primary navigation'>
                <button
                    className='modern-layout__brand'
                    type='button'
                    aria-label={`Go to ${props.navItems[0]?.title || 'Workflows'} home`}
                    onClick={() => navigate(props.navItems[0]?.path ?? uiUrl('workflows'))}>
                    <img src='assets/images/logo.png' alt='workflows' />
                    <div className='modern-layout__brand-copy'>
                        <span className='modern-layout__brand-title'>workflows</span>
                        {versionContent && <span className='modern-layout__version'>{versionContent}</span>}
                    </div>
                </button>
                <div className='modern-layout__items'>
                    {props.navItems.map((item, index) => (
                        <React.Fragment key={item.path + item.title}>
                            {(index === 0 || props.navItems[index - 1].group !== item.group) && <div className='modern-layout__section-label'>{item.group || 'Overview'}</div>}
                            <button
                                className={`modern-layout__item ${[item.path, ...(item.activePaths || [])].some(path => isActiveRoute(locationPath, path)) ? 'active' : ''}`}
                                title={item.title}
                                aria-label={item.title}
                                aria-current={[item.path, ...(item.activePaths || [])].some(path => isActiveRoute(locationPath, path)) ? 'page' : undefined}
                                onMouseEnter={event => {
                                    if (!navExpanded) {
                                        setHoveredItem({
                                            title: item.title,
                                            top: event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2
                                        });
                                    }
                                }}
                                onMouseLeave={() => setHoveredItem(undefined)}
                                onFocus={() => {
                                    if (!navExpanded) {
                                        const rect = document.activeElement?.getBoundingClientRect();
                                        if (rect) {
                                            setHoveredItem({title: item.title, top: rect.top + rect.height / 2});
                                        }
                                    }
                                }}
                                onBlur={() => setHoveredItem(undefined)}
                                onClick={() => navigate(item.path)}>
                                <i className='modern-layout__item-chevron fa fa-angle-right' aria-hidden='true' />
                                <i className={item.iconClassName} aria-hidden='true' />
                                <span>{item.title}</span>
                            </button>
                        </React.Fragment>
                    ))}
                </div>
                <div className='modern-layout__footer'>
                    <button
                        className={`modern-layout__theme-toggle ${theme === 'dark' ? 'modern-layout__theme-toggle--on' : ''}`}
                        type='button'
                        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                        aria-pressed={theme === 'dark'}
                        onClick={() => setTheme(value => (value === 'dark' ? 'light' : 'dark'))}>
                        <span className='modern-layout__theme-label'>{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
                        <span className='modern-layout__theme-switch' aria-hidden='true'>
                            <span className='modern-layout__theme-thumb'>
                                <i className={`fa ${theme === 'dark' ? 'fa-moon' : 'fa-sun'}`} />
                            </span>
                        </span>
                    </button>
                    <div className='modern-layout__account'>
                        <i className='fa fa-user-circle' aria-hidden='true' />
                        <span className='modern-layout__account-note'>{props.userName || 'Argo user'}</span>
                        <button
                            className='modern-layout__collapse'
                            type='button'
                            title={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
                            aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
                            aria-expanded={navExpanded}
                            onClick={toggleNavigation}>
                            <i className={`fa ${navExpanded ? 'fa-angle-left' : 'fa-angle-right'}`} aria-hidden='true' />
                        </button>
                    </div>
                </div>
            </nav>
            {hoveredItem && !navExpanded && (
                <div className='modern-layout__item-tooltip' role='tooltip' style={{top: hoveredItem.top}}>
                    {hoveredItem.title}
                </div>
            )}
            <main id='main-content' className='modern-layout__content' tabIndex={-1}>
                {props.children}
            </main>
        </div>
    );
}
