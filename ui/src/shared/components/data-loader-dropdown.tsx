import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import {SelectOption} from './accessible-select';
import {SearchableSelect} from './searchable-select';

import './data-loader-dropdown.scss';

export function DataLoaderDropdown(props: {
    load: () => Promise<(string | SelectOption)[]>;
    loadKey?: string;
    onChange: (value: string) => void;
    placeholder?: string;
    value?: string;
    ariaLabel?: string;
    id?: string;
}) {
    const [selected, setSelected] = useState('');
    const [options, setOptions] = useState<(string | SelectOption)[]>();
    const [error, setError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const loadRef = useRef(props.load);
    loadRef.current = props.load;

    useEffect(() => {
        let cancelled = false;
        setOptions(undefined);
        setError(false);
        loadRef
            .current()
            .then(items => {
                if (!cancelled) {
                    setOptions(items);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setError(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [props.loadKey, reloadKey]);

    if (error) {
        return (
            <div className='data-loader-dropdown__error' role='alert'>
                Could not load options.{' '}
                <button type='button' className='data-loader-dropdown__retry' onClick={() => setReloadKey(value => value + 1)}>
                    Retry
                </button>
            </div>
        );
    }

    if (!options) {
        return <div className='data-loader-dropdown__loading'>Loading options…</div>;
    }

    const value = props.value === undefined ? selected : props.value;
    return (
        <div>
            <SearchableSelect
                id={props.id}
                ariaLabel={props.ariaLabel}
                placeholder={props.placeholder}
                options={options}
                value={value}
                allowClear
                onChange={x => {
                    setSelected(x.value);
                    props.onChange(x.value);
                }}
            />
        </div>
    );
}
