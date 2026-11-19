import {labels, Workflow} from './models';
import {getStartedBy, startedByText} from './started-by';

function workflow(withLabels?: Record<string, string>): Workflow {
    return {
        metadata: {
            name: 'test-wf',
            namespace: 'argo',
            labels: withLabels
        }
    } as Workflow;
}

describe('getStartedBy', () => {
    it('prefers creator labels', () => {
        const startedBy = getStartedBy(workflow({[labels.creatorPreferredUsername]: 'alice', [labels.creator]: 'argo:alice'}));
        expect(startedBy.kind).toBe('user');
        expect(startedBy.name).toBe('alice');
        expect(startedByText(startedBy)).toBe('alice');
    });

    it('falls back to the raw creator label', () => {
        expect(getStartedBy(workflow({[labels.creator]: 'argo:alice'})).name).toBe('argo:alice');
    });

    it('identifies schedule-started runs', () => {
        const startedBy = getStartedBy(workflow({[labels.cronWorkflow]: 'nightly-backup'}));
        expect(startedBy.kind).toBe('schedule');
        expect(startedByText(startedBy)).toBe('schedule nightly-backup');
    });

    it('identifies event-started runs', () => {
        const startedBy = getStartedBy(workflow({'workflows.argoproj.io/workflow-event-binding': 'on-pr'}));
        expect(startedBy.kind).toBe('event');
        expect(startedByText(startedBy)).toBe('event on-pr');
    });

    it('identifies reruns', () => {
        const startedBy = getStartedBy(workflow({'workflows.argoproj.io/resubmitted-from-workflow': 'old-run'}));
        expect(startedBy.kind).toBe('rerun');
        expect(startedByText(startedBy)).toBe('rerun of old-run');
    });

    it('identifies UI submissions', () => {
        expect(getStartedBy(workflow({'submit-from-ui': 'true'})).kind).toBe('ui');
    });

    it('returns unknown without any markers', () => {
        const startedBy = getStartedBy(workflow());
        expect(startedBy.kind).toBe('unknown');
        expect(startedByText(startedBy)).toBe('Unknown');
    });
});
