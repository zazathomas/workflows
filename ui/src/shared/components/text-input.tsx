import * as React from 'react';

export const TextInput = ({
    placeholder,
    ariaLabel,
    id,
    value,
    onChange,
    readOnly
}: {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    id?: string;
}) => (readOnly ? <>{value}</> : <input id={id} aria-label={ariaLabel} className='argo-field' value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />);
