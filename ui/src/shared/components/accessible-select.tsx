import * as React from 'react';

export interface SelectOption {
    value: string;
    title: string;
}

export interface SelectProps {
    placeholder?: string;
    value?: string | string[];
    options: Array<SelectOption | string>;
    onChange?: (option: SelectOption) => any;
    onMultiChange?: (options: SelectOption[]) => any;
    multiSelect?: boolean;
    id?: string;
    ariaLabel?: string;
}

function normalizeOptions(options: Array<SelectOption | string>): SelectOption[] {
    return options.map(item => (typeof item === 'string' ? {value: item, title: item} : item));
}

/**
 * Accessible replacement for the argo-ui Select. Renders a native <select>,
 * which is keyboard- and screen-reader-operable by default (focusable trigger,
 * visible focus, role=combobox/listbox, arrow-key navigation, typeahead).
 */
export function Select(props: SelectProps) {
    const options = normalizeOptions(props.options);

    if (props.multiSelect) {
        const values = Array.isArray(props.value) ? props.value : props.value ? [props.value] : [];
        return (
            <select
                id={props.id}
                aria-label={props.ariaLabel}
                multiple={true}
                className='argo-field'
                value={values}
                onChange={event => {
                    const selected = Array.from(event.target.selectedOptions).map(option => ({value: option.value, title: option.textContent || option.value}));
                    if (props.onMultiChange) {
                        props.onMultiChange(selected);
                    }
                }}>
                {options.map(option => (
                    <option key={option.value} value={option.value}>
                        {option.title}
                    </option>
                ))}
            </select>
        );
    }

    const value = Array.isArray(props.value) ? props.value[0] : props.value;
    return (
        <select
            id={props.id}
            aria-label={props.ariaLabel}
            className='argo-field'
            value={value === undefined || value === null ? '' : value}
            onChange={event => {
                const selected = options.find(option => option.value === event.target.value);
                if (props.onChange) {
                    props.onChange(selected || {value: event.target.value, title: event.target.value});
                }
            }}>
            {props.placeholder && <option value=''>{props.placeholder}</option>}
            {options.map(option => (
                <option key={option.value} value={option.value}>
                    {option.title}
                </option>
            ))}
        </select>
    );
}
