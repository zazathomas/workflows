import * as React from 'react';

import {InputFilter} from './input-filter';

import './search-mode-filter.scss';

export const SEARCH_MODE_OPTIONS: SearchModeOption[] = [
    {value: 'name', label: 'Name or title contains'},
    {value: 'team', label: 'Team'},
    {value: 'label', label: 'Label contains'}
];

export interface SearchModeOption {
    value: string;
    label: string;
}

/**
 * Shared search control: choose what to search by, then type a pattern.
 * Filters retain their values when the mode changes.
 */
export function SearchModeFilter(props: {
    id: string;
    mode: string;
    options: SearchModeOption[];
    onModeChange: (mode: string) => void;
    modeAriaLabel: string;
    value: string;
    onValueChange: (value: string) => void;
    inputName: string;
    inputAriaLabel: string;
    placeholder: string;
    hint?: string;
}) {
    const hintId = props.hint ? `${props.id}-hint` : undefined;
    return (
        <div className='search-mode-filter'>
            <div className='search-mode-filter__row'>
                <select
                    id={`${props.id}-mode`}
                    className='argo-field search-mode-filter__mode'
                    aria-label={props.modeAriaLabel}
                    value={props.mode}
                    onChange={event => props.onModeChange(event.target.value)}>
                    {props.options.map(option => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
                <InputFilter
                    key={props.mode}
                    id={props.id}
                    name={props.inputName}
                    value={props.value}
                    ariaLabel={props.inputAriaLabel}
                    ariaDescribedBy={hintId}
                    placeholder={props.placeholder}
                    changeDelay={300}
                    filterSuggestions
                    autoHighlight={false}
                    onChange={props.onValueChange}
                />
            </div>
            {props.hint && (
                <small id={hintId} className='search-mode-filter__hint'>
                    {props.hint}
                </small>
            )}
        </div>
    );
}
