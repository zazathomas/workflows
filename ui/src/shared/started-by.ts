import {labels, Workflow} from './models';

/**
 * Derive who or what started a run, for a \"Started by\" column and run header.
 * AWX, Rundeck and Semaphore all surface this on their execution lists.
 */

export type StartedByKind = 'user' | 'schedule' | 'event' | 'rerun' | 'ui' | 'unknown';

export interface StartedBy {
    kind: StartedByKind;
    // Human-readable name of the actor (a user, or the schedule/event-binding that triggered the run).
    name: string;
    icon: string;
}

const EVENT_BINDING_LABEL = 'workflows.argoproj.io/workflow-event-binding';
const RESUBMITTED_FROM_LABEL = 'workflows.argoproj.io/resubmitted-from-workflow';

export function getStartedBy(workflow: Workflow): StartedBy {
    const labelsMap = workflow?.metadata?.labels || {};
    const creator = labelsMap[labels.creatorPreferredUsername] || labelsMap[labels.creatorEmail] || labelsMap[labels.creator];
    if (creator) {
        return {kind: 'user', name: creator, icon: 'fa fa-user'};
    }
    const cronWorkflow = labelsMap[labels.cronWorkflow];
    if (cronWorkflow) {
        return {kind: 'schedule', name: cronWorkflow, icon: 'fa fa-clock'};
    }
    const eventBinding = labelsMap[EVENT_BINDING_LABEL];
    if (eventBinding) {
        return {kind: 'event', name: eventBinding, icon: 'fa fa-bolt'};
    }
    const resubmittedFrom = labelsMap[RESUBMITTED_FROM_LABEL];
    if (resubmittedFrom) {
        return {kind: 'rerun', name: resubmittedFrom, icon: 'fa fa-undo'};
    }
    if (labelsMap['submit-from-ui'] === 'true') {
        return {kind: 'ui', name: 'UI', icon: 'fa fa-desktop'};
    }
    return {kind: 'unknown', name: '', icon: ''};
}

export function startedByText(startedBy: StartedBy): string {
    switch (startedBy.kind) {
        case 'user':
        case 'ui':
            return startedBy.name;
        case 'schedule':
            return `schedule ${startedBy.name}`;
        case 'event':
            return `event ${startedBy.name}`;
        case 'rerun':
            return `rerun of ${startedBy.name}`;
        default:
            return 'Unknown';
    }
}
