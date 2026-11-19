import * as React from 'react';

import {uiUrl} from '../shared/base';
import {ClipboardText} from '../shared/components/clipboard-text';

import './trigger-panel.scss';

interface TriggerPanelProps {
    kind: 'WorkflowTemplate' | 'ClusterWorkflowTemplate';
    namespace: string;
    name: string;
}

/**
 * \"How to trigger this job\": copyable CLI and webhook snippets on the Job page
 * (AWX webhook fields + Semaphore integrations pattern).
 */
export function TriggerPanel({kind, namespace, name}: TriggerPanelProps) {
    const fromFlag = kind === 'ClusterWorkflowTemplate' ? 'clusterworkflowtemplate' : 'workflowtemplate';
    const cli = `argo submit --from ${fromFlag}/${name}${kind === 'ClusterWorkflowTemplate' ? ` -n ${namespace}` : ''}`;
    const curl = [
        `# Send an event to argo-server; a Sensor wired via a WorkflowEventBinding can start this job`,
        `curl -X POST "$ARGO_SERVER/api/v1/events/${namespace}/" \\`,
        `  -H "Authorization: Bearer $ARGO_TOKEN" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"type": "start", "job": "${name}"}'`
    ].join('\n');

    return (
        <div className='trigger-panel'>
            <h4>Trigger this job</h4>
            <section className='trigger-panel__section'>
                <h5>CLI</h5>
                <p className='trigger-panel__hint'>Run the job from the command line:</p>
                <pre>
                    <code>
                        <ClipboardText text={cli} />
                    </code>
                </pre>
            </section>
            <section className='trigger-panel__section'>
                <h5>Webhook</h5>
                <p className='trigger-panel__hint'>
                    To start the job from a webhook, wire an <a href={uiUrl('event-sources')}>Event Source</a> and a{' '}
                    <a href={uiUrl('workflow-event-bindings')}>Workflow Event Binding</a> that submits this template, then POST an event:
                </p>
                <pre>
                    <code>
                        <ClipboardText text={curl} />
                    </code>
                </pre>
            </section>
        </div>
    );
}
