import {fireEvent, render} from '@testing-library/react';
import {createMemoryHistory} from 'history';
import * as React from 'react';

import {ModernLayout} from './modern-layout';

describe('ModernLayout', () => {
    beforeEach(() => {
        window.localStorage.clear();
        document.body.className = '';
    });

    it('renders accessible navigation and defaults to dark mode, persisting the theme choice', () => {
        const history = createMemoryHistory({initialEntries: ['/workflows']});
        const {getByRole} = render(
            <ModernLayout history={history} navItems={[{path: '/workflows', iconClassName: 'fa fa-stream', title: 'Workflows'}]}>
                <div>content</div>
            </ModernLayout>
        );

        expect(getByRole('navigation', {name: 'Primary navigation'})).toBeInTheDocument();
        expect(getByRole('button', {name: 'Workflows'})).toHaveAttribute('aria-current', 'page');

        const themeButton = getByRole('button', {name: 'Switch to light mode'});
        expect(getByRole('navigation', {name: 'Primary navigation'})).toContainElement(themeButton);
        expect(themeButton.closest('.modern-layout__footer')).not.toBeNull();
        expect(themeButton).toHaveClass('modern-layout__theme-toggle--on');
        expect(themeButton.querySelector('.modern-layout__theme-switch')).toBeInTheDocument();
        expect(document.body).toHaveClass('modern-theme-dark');

        fireEvent.click(themeButton);

        expect(getByRole('button', {name: 'Switch to dark mode'})).not.toHaveClass('modern-layout__theme-toggle--on');
        expect(window.localStorage.getItem('argo-ui-theme')).toBe('light');
        expect(document.body).not.toHaveClass('modern-theme-dark');
    });

    it('expands navigation only through the footer control', () => {
        const history = createMemoryHistory({initialEntries: ['/workflows']});
        const {container, getByRole} = render(
            <ModernLayout
                history={history}
                navItems={[
                    {path: '/workflows', iconClassName: 'fa fa-stream', title: 'Workflows'},
                    {path: '/templates', iconClassName: 'fa fa-window-maximize', title: 'Templates'}
                ]}>
                <div>content</div>
            </ModernLayout>
        );

        const navigation = getByRole('navigation', {name: 'Primary navigation'});
        fireEvent.mouseEnter(navigation);
        expect(container.querySelector('.modern-layout')).not.toHaveClass('modern-layout--expanded');
        fireEvent.mouseEnter(getByRole('button', {name: 'Workflows'}));
        expect(getByRole('tooltip', {name: 'Workflows'})).toBeInTheDocument();
        fireEvent.mouseLeave(getByRole('button', {name: 'Workflows'}));
        expect(container.querySelector('[role="tooltip"]')).not.toBeInTheDocument();
        fireEvent.click(getByRole('button', {name: 'Expand navigation'}));
        expect(container.querySelector('.modern-layout')).toHaveClass('modern-layout--expanded');
        expect(window.localStorage.getItem('argo-ui-navigation-expanded')).toBe('true');
        fireEvent.click(getByRole('button', {name: 'Templates'}));
        expect(history.location.pathname).toBe('/templates');
        expect(container.querySelector('.modern-layout')).toHaveClass('modern-layout--expanded');
        fireEvent.click(getByRole('button', {name: 'Collapse navigation'}));
        expect(container.querySelector('.modern-layout')).not.toHaveClass('modern-layout--expanded');
    });

    it('keeps expansion controlled while preserving mobile keyboard behavior', () => {
        const history = createMemoryHistory({initialEntries: ['/workflows']});
        const {container, getByRole} = render(
            <ModernLayout history={history} navItems={[{path: '/workflows', iconClassName: 'fa fa-stream', title: 'Workflows'}]}>
                <div>content</div>
            </ModernLayout>
        );

        const navigation = getByRole('navigation', {name: 'Primary navigation'});
        const workflowButton = getByRole('button', {name: 'Workflows'});
        fireEvent.focus(workflowButton);
        expect(container.querySelector('.modern-layout')).not.toHaveClass('modern-layout--expanded');
        fireEvent.blur(workflowButton, {relatedTarget: document.body});
        expect(container.querySelector('.modern-layout')).not.toHaveClass('modern-layout--expanded');

        const menuButton = getByRole('button', {name: 'Open navigation'});
        menuButton.focus();
        fireEvent.click(menuButton);
        expect(menuButton).toHaveAttribute('aria-expanded', 'true');
        expect(navigation).toContainElement(document.activeElement as HTMLElement);
        fireEvent.keyDown(document, {key: 'Escape'});
        expect(menuButton).toHaveAttribute('aria-expanded', 'false');
        expect(document.activeElement).toBe(menuButton);
    });

    it('moves keyboard focus to the main content from the skip link', () => {
        const history = createMemoryHistory({initialEntries: ['/workflows']});
        const {getByRole} = render(
            <ModernLayout history={history} navItems={[{path: '/workflows', iconClassName: 'fa fa-stream', title: 'Workflows'}]}>
                <div>content</div>
            </ModernLayout>
        );

        const skipLink = getByRole('link', {name: 'Skip to main content'});
        fireEvent.click(skipLink);

        expect(document.activeElement).toBe(getByRole('main'));
    });
});
