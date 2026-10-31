import {Autocomplete} from 'argo-ui/src/components/autocomplete/autocomplete';
import React, {useEffect, useMemo, useRef, useState} from 'react';

import './input-filter.scss';

interface InputProps {
    value: string;
    placeholder?: string;
    ariaLabel?: string;
    ariaDescribedBy?: string;
    clearLabel?: string;
    id?: string;
    name: string;
    onChange: (input: string) => void;
    filterSuggestions?: boolean;
    autoHighlight?: boolean;
    extraSuggestions?: string[];
    changeDelay?: number;
}

export function InputFilter(props: InputProps) {
    const [value, setValue] = useState(props.value);
    const [localCache, setLocalCache] = useState((localStorage.getItem(props.name + '_inputs') || '').split(',').filter(item => item !== ''));
    const changeTimeout = useRef<ReturnType<typeof setTimeout>>();
    const items = useMemo(() => Array.from(new Set([...(props.extraSuggestions ?? []), ...localCache])), [localCache, props.extraSuggestions]);

    useEffect(() => setValue(props.value), [props.value]);
    useEffect(() => () => clearTimeout(changeTimeout.current), []);

    function cancelDelayedChange() {
        clearTimeout(changeTimeout.current);
        changeTimeout.current = undefined;
    }

    function scheduleChange(newValue: string) {
        if (props.changeDelay === undefined) {
            return;
        }
        cancelDelayedChange();
        changeTimeout.current = setTimeout(() => props.onChange(newValue), props.changeDelay);
    }

    function setValueAndCache(newValue: string) {
        setLocalCache(currentCache => {
            const updatedCache = [...currentCache];
            if (!updatedCache.includes(newValue)) {
                updatedCache.unshift(newValue);
            }
            while (updatedCache.length > 5) {
                updatedCache.pop();
            }
            localStorage.setItem(props.name + '_inputs', updatedCache.join(','));
            return updatedCache;
        });
        setValue(newValue);
    }

    function renderInput(inputProps: React.HTMLProps<HTMLInputElement>) {
        return (
            <input
                {...inputProps}
                onKeyUp={event => {
                    if (event.keyCode === 13) {
                        const inputValue = event.currentTarget.value;
                        cancelDelayedChange();
                        setValueAndCache(inputValue);
                        props.onChange(inputValue);
                    }
                }}
                aria-label={props.ariaLabel}
                aria-describedby={props.ariaDescribedBy}
                className='argo-field'
                id={props.id}
                placeholder={props.placeholder}
            />
        );
    }

    return (
        <div className='input-filter'>
            <Autocomplete
                items={items}
                value={value}
                onChange={(e, newValue) => {
                    setValue(newValue);
                    scheduleChange(newValue);
                }}
                onSelect={newValue => {
                    cancelDelayedChange();
                    setValueAndCache(newValue);
                    props.onChange(newValue);
                }}
                renderInput={renderInput}
                filterSuggestions={props.filterSuggestions}
                autoHighlight={props.autoHighlight}
            />
            <button
                type='button'
                className='input-filter__clear'
                aria-label={props.clearLabel || 'Clear filter'}
                onClick={() => {
                    cancelDelayedChange();
                    setValue('');
                    props.onChange('');
                }}>
                <i className='fa fa-times-circle' aria-hidden='true' />
            </button>
        </div>
    );
}
