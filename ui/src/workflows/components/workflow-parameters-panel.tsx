import * as React from 'react';

import {Parameter} from '../../shared/models';

import './workflow-parameters-panel.scss';

function ParameterValue({value}: {value?: string}) {
    if (!value?.includes('\n')) return <>{value}</>;

    const firstLine = value.split(/\r?\n/, 1)[0];
    return (
        <details className='workflow-parameter-value'>
            <summary>
                <span className='workflow-parameter-value__preview'>{firstLine}…</span>
                <span className='workflow-parameter-value__view'>View full value</span>
                <span className='workflow-parameter-value__hide'>Hide full value</span>
            </summary>
            <pre className='workflow-parameter-value__full'>{value}</pre>
        </details>
    );
}

export const WorkflowParametersPanel = (props: {parameters: Parameter[]}) => (
    <div className='white-box'>
        <div className='white-box__details'>
            {props.parameters.map(param => (
                <div className='row white-box__details-row' key={param.name}>
                    <div className='columns small-3'>{param.name}</div>
                    <div className='columns small-9'>
                        <ParameterValue value={param.value} />
                    </div>
                </div>
            ))}
        </div>
    </div>
);
