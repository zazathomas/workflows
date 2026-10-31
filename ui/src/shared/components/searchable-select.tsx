import * as React from 'react';
import {useEffect, useMemo, useState} from 'react';

import {SelectOption} from './accessible-select';

import './searchable-select.scss';

let nextId = 0;

export function SearchableSelect(props: {
    id?: string;
    ariaLabel?: string;
    placeholder?: string;
    value?: string;
    options: Array<string | SelectOption>;
    onChange: (option: SelectOption) => void;
    allowClear?: boolean;
}) {
    const [listId] = useState(() => `searchable-select-${++nextId}`);
    const options = useMemo(() => props.options.map(option => (typeof option === 'string' ? {value: option, title: option} : option)), [props.options]);
    const selected = options.find(option => option.value === props.value);
    const displayValue = selected?.title || (props.value ? `${props.value} (not in available options)` : '');
    const [query, setQuery] = useState(displayValue);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const matches = options.filter(option => option.title.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));

    useEffect(() => {
        if (!open) setQuery(displayValue);
    }, [displayValue, open]);

    useEffect(() => {
        if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({block: 'nearest'});
    }, [active, listId, open]);

    function choose(option: SelectOption) {
        setQuery(option.title);
        setOpen(false);
        setActive(-1);
        props.onChange(option);
    }

    function dismiss() {
        setQuery(displayValue);
        setOpen(false);
        setActive(-1);
    }

    return (
        <div className='searchable-select'>
            <input
                id={props.id}
                aria-label={props.ariaLabel}
                className='argo-field searchable-select__input'
                role='combobox'
                aria-autocomplete='list'
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={open && active >= 0 && active < matches.length ? `${listId}-${active}` : undefined}
                value={query}
                placeholder={props.placeholder}
                onFocus={() => {
                    setQuery('');
                    setOpen(true);
                    setActive(-1);
                }}
                onChange={event => {
                    setQuery(event.target.value);
                    setOpen(true);
                    setActive(-1);
                }}
                onBlur={dismiss}
                onKeyDown={event => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setOpen(true);
                        if (matches.length)
                            setActive(current => (event.key === 'ArrowDown' ? Math.min(current + 1, matches.length - 1) : current <= 0 ? matches.length - 1 : current - 1));
                    } else if (event.key === 'Enter' && open) {
                        event.preventDefault();
                        if (active >= 0 && matches[active]) choose(matches[active]);
                    } else if (event.key === 'Escape' && open) {
                        event.preventDefault();
                        event.stopPropagation();
                        dismiss();
                    }
                }}
            />
            {props.allowClear && props.value && (
                <button type='button' className='searchable-select__clear' aria-label={`Clear ${props.ariaLabel || 'selection'}`} onClick={() => choose({value: '', title: ''})}>
                    Clear
                </button>
            )}
            {open && (
                <div className='searchable-select__popup'>
                    <div id={listId} role='listbox' aria-label={props.ariaLabel ? `${props.ariaLabel} options` : 'Options'}>
                        {matches.map((option, index) => (
                            <div
                                id={`${listId}-${index}`}
                                key={option.value}
                                role='option'
                                aria-selected={option.value === props.value}
                                className={index === active ? 'searchable-select__option searchable-select__option--active' : 'searchable-select__option'}
                                onMouseEnter={() => setActive(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(option)}>
                                {option.title}
                            </div>
                        ))}
                    </div>
                    <div className='searchable-select__status' role='status' aria-live='polite'>
                        {matches.length ? `${matches.length} available ${matches.length === 1 ? 'option' : 'options'}` : 'No matching loaded options'}
                    </div>
                </div>
            )}
        </div>
    );
}
