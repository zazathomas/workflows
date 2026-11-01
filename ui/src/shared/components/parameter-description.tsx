import * as React from 'react';
import {useState} from 'react';

// Collapsed by default so long parameter lists stay readable; the question mark
// reveals one description at a time and works from the keyboard.
export function ParameterDescription({id, name, description}: {id: string; name: string; description?: string}) {
    const [shown, setShown] = useState(false);
    if (!description) {
        return null;
    }
    return (
        <>
            <button
                type='button'
                className='parameter-description__toggle'
                aria-expanded={shown}
                aria-controls={id}
                aria-label={`${shown ? 'Hide' : 'Show'} description for ${name}`}
                onClick={() => setShown(value => !value)}>
                <i className='fa fa-question-circle' aria-hidden='true' />
            </button>
            <small id={id} className='parameter-description' hidden={!shown}>
                {description}
            </small>
        </>
    );
}
