import classNames from 'classnames';
import * as React from 'react';
import {useState} from 'react';

import './saved-views.scss';

/**
 * A generic saved-views bar (Temporal Web UI pattern): named filter
 * combinations rendered as chips. The parent owns the filters, the storage and
 * what \"apply\" means; this component only renders chips and collects names for
 * new views.
 */

export interface SavedViewFilters {
    [key: string]: string[] | string | undefined;
}

export interface SavedView {
    name: string;
    filters: SavedViewFilters;
    builtIn?: boolean;
}

/** Canonical serialization used to decide which chip is active. */
export function viewKey(filters: SavedViewFilters): string {
    return JSON.stringify(filters, Object.keys(filters).sort());
}

export function matchesCurrentView(view: SavedView, key: string): boolean {
    return viewKey(view.filters) === key;
}

interface SavedViewsBarProps {
    views: SavedView[];
    currentKey: string;
    onApply: (view: SavedView) => void;
    onSave: (name: string) => void;
    onDelete: (view: SavedView) => void;
}

export function SavedViewsBar({views, currentKey, onApply, onSave, onDelete}: SavedViewsBarProps) {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState('');
    const hasActiveFilters = views.some(view => matchesCurrentView(view, currentKey));

    return (
        <div className='saved-views' role='group' aria-label='Saved views'>
            {views.map(view => (
                <span key={view.name} className={classNames('saved-views__chip', {active: matchesCurrentView(view, currentKey)})}>
                    <button type='button' className='saved-views__apply' onClick={() => onApply(view)} title={`Apply view ${view.name}`}>
                        {view.name}
                    </button>
                    {!view.builtIn && (
                        <button
                            type='button'
                            className='saved-views__delete'
                            aria-label={`Delete view ${view.name}`}
                            title={`Delete view ${view.name}`}
                            onClick={() => onDelete(view)}>
                            <i className='fa fa-times' aria-hidden='true' />
                        </button>
                    )}
                </span>
            ))}
            {naming ? (
                <form
                    className='saved-views__form'
                    onSubmit={event => {
                        event.preventDefault();
                        if (name.trim()) {
                            onSave(name.trim());
                        }
                        setName('');
                        setNaming(false);
                    }}>
                    <input
                        autoFocus
                        className='argo-field saved-views__name'
                        aria-label='View name'
                        placeholder='View name'
                        value={name}
                        onChange={event => setName(event.target.value)}
                        onBlur={() => {
                            if (name.trim()) {
                                onSave(name.trim());
                            }
                            setName('');
                            setNaming(false);
                        }}
                    />
                    <button type='submit' className='argo-button argo-button--base-o'>
                        Save
                    </button>
                </form>
            ) : (
                <button type='button' className='argo-button argo-button--base-o saved-views__save' onClick={() => setNaming(true)} title='Save the current filters as a view'>
                    <i className='fa fa-plus' aria-hidden='true' /> Save view
                </button>
            )}
            {hasActiveFilters && <span className='saved-views__hint'>Views match the current filters; the URL always shares the exact filter state.</span>}
        </div>
    );
}
