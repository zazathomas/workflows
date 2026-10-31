import React from 'react';

import {Parameter} from '../models';
import {Select} from './accessible-select';

import './dynamic-parameters-input.scss';

export function getValueFromParameter(p: Parameter) {
    if (p.value === undefined) {
        return p.default;
    } else {
        return p.value;
    }
}

interface ParametersInputProps {
    parameters: Parameter[];
    onChange: (parameters: Parameter[]) => void;
}

function isRequired(parameter: Parameter): boolean {
    return parameter.default === undefined && parameter.value === undefined;
}

export function ParametersInput(props: ParametersInputProps) {
    function onParameterChange(parameter: Parameter, value: string) {
        const newParameters: Parameter[] = props.parameters.map(p => ({
            ...p,
            value: p.name === parameter.name ? value : getValueFromParameter(p)
        }));
        props.onChange(newParameters);
    }

    return (
        <>
            {props.parameters.map((parameter, index) => {
                const inputId = `parameter-${parameter.name}-${index}`;
                const descriptionId = `${inputId}-description`;
                const required = isRequired(parameter);
                const value = getValueFromParameter(parameter);
                return (
                    <div key={parameter.name + '_' + index} style={{marginBottom: 14}}>
                        <label htmlFor={inputId}>
                            {parameter.name}
                            {required && <span> (required)</span>}
                        </label>
                        {parameter.description && (
                            <small id={descriptionId} className='parameter-description'>
                                {parameter.description}
                            </small>
                        )}
                        {parameter.enum ? (
                            <Select
                                id={inputId}
                                value={value}
                                options={parameter.enum.map(enumValue => ({value: enumValue, title: enumValue}))}
                                onChange={option => onParameterChange(parameter, option.value)}
                            />
                        ) : (
                            <textarea
                                id={inputId}
                                className='argo-field'
                                value={value}
                                aria-required={required}
                                aria-describedby={parameter.description ? descriptionId : undefined}
                                onChange={event => onParameterChange(parameter, event.target.value)}
                            />
                        )}
                    </div>
                );
            })}
        </>
    );
}
