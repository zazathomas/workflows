import * as React from 'react';
import {useState} from 'react';

import {Select} from '../../../shared/components/accessible-select';
import {Parameter} from '../../../shared/models';

interface SuspendInputProps {
    parameters: Parameter[];
    nodeId: string;
    setParameter: (key: string, value: string) => void;
}

export function SuspendInputs(props: SuspendInputProps) {
    const [parameters, setParameters] = useState(props.parameters);

    function setParameter(key: string, value: string) {
        props.setParameter(key, value);
        setParameters(previous => {
            return previous.map(param => {
                if (param.name === key) {
                    param.value = value;
                }
                return param;
            });
        });
    }

    function renderSelectField(parameter: Parameter) {
        const id = `suspend-parameter-${parameter.name}`;
        return (
            <React.Fragment key={parameter.name}>
                <br />
                <label htmlFor={id}>{parameter.name}</label>
                {parameter.description && <small style={{display: 'block', marginTop: 2, color: '#607086'}}>{parameter.description}</small>}
                <Select
                    id={id}
                    value={parameter.value || parameter.default}
                    options={parameter.enum.map(value => ({
                        value,
                        title: value
                    }))}
                    onChange={selected => setParameter(parameter.name, selected.value)}
                />
            </React.Fragment>
        );
    }

    function renderInputField(parameter: Parameter) {
        const id = `suspend-parameter-${parameter.name}`;
        return (
            <React.Fragment key={parameter.name}>
                <br />
                <label htmlFor={id}>{parameter.name}</label>
                {parameter.description && <small style={{display: 'block', marginTop: 2, color: '#607086'}}>{parameter.description}</small>}
                <input id={id} className='argo-field' defaultValue={parameter.value || parameter.default} onChange={event => setParameter(parameter.name, event.target.value)} />
            </React.Fragment>
        );
    }

    function renderFields(parameter: Parameter) {
        if (parameter.enum) {
            return renderSelectField(parameter);
        }
        return renderInputField(parameter);
    }

    function renderInputContentIfApplicable() {
        if (parameters.length === 0) {
            return <React.Fragment />;
        }
        return (
            <React.Fragment>
                <h2>Modify parameters</h2>
                {parameters.map(renderFields)}
                <br />
            </React.Fragment>
        );
    }

    return (
        <div>
            {renderInputContentIfApplicable()}
            <br />
            Are you sure you want to resume node {props.nodeId} ?
        </div>
    );
}
