import * as React from 'react';

export function ParameterDescription({id, description}: {id: string; description?: string}) {
    return description ? (
        <small id={id} className='parameter-description'>
            {description}
        </small>
    ) : null;
}
