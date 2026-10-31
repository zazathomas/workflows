import * as React from 'react';

import * as nsUtils from '../namespaces';
import {InputFilter} from './input-filter';

import './namespace-filter.scss';

export const NamespaceFilter = (props: {value: string; onChange: (namespace: string) => void; extraNamespaces?: string[]; ariaLabel?: string; id?: string}) => {
    const managedNamespace = nsUtils.getManagedNamespace();
    if (managedNamespace) return <>{managedNamespace}</>;

    return (
        <div className='namespace-filter'>
            <InputFilter
                id={props.id}
                ariaLabel={props.ariaLabel || 'Namespace'}
                clearLabel='Clear namespace filter'
                name='ns'
                value={props.value || ''}
                placeholder='Type a namespace and press Enter'
                extraSuggestions={props.extraNamespaces}
                filterSuggestions
                autoHighlight={false}
                onChange={props.onChange}
            />
            <small className='namespace-filter__hint'>Suggestions come from loaded results and recently entered namespaces.</small>
        </div>
    );
};
