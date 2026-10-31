import {workflowsToChartData} from './workflows-to-chart-data';

describe('workflowsToChartData', () => {
    it('creates themed, interactive histogram options', () => {
        const [duration, resources] = workflowsToChartData(
            [
                {
                    metadata: {name: 'workflow-a'},
                    status: {
                        phase: 'Succeeded',
                        startedAt: '2026-01-01T00:00:00Z',
                        finishedAt: '2026-01-01T00:01:00Z',
                        resourcesDuration: {cpu: 12}
                    }
                } as any
            ],
            100,
            true
        );

        expect(duration.options.maintainAspectRatio).toBe(false);
        expect(duration.options.scales.yAxes[0].ticks.fontColor).toBe('#dbeafe');
        expect(duration.options.annotation.annotations[0].borderDash).toEqual([6, 5]);
        expect((resources.data.datasets[0] as any).yAxisID).toBe('cpu');
        expect((resources.data.datasets[0] as any).backgroundColor).toBe('#14b8a6');
        expect(duration.options.scales.yAxes[0].ticks.callback(60)).toBe('1m');
    });

    it('excludes workflows with invalid or negative durations', () => {
        const [duration] = workflowsToChartData(
            [
                {
                    metadata: {name: 'invalid'},
                    status: {phase: 'Succeeded', startedAt: '2026-01-02T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z'}
                },
                {
                    metadata: {name: 'valid'},
                    status: {phase: 'Succeeded', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z'}
                }
            ] as any,
            100
        );

        expect(duration.data.labels).toEqual(['valid']);
        expect(duration.data.datasets[0].data).toEqual([60]);
    });
});

describe('workflow title labels', () => {
    it('uses the display title while retaining the workflow name for navigation', () => {
        const [duration] = workflowsToChartData(
            [
                {
                    metadata: {name: 'technical-id', annotations: {'workflows.argoproj.io/title': 'Friendly report'}},
                    status: {phase: 'Succeeded', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z'}
                } as any
            ],
            100
        );
        expect(duration.data.labels).toEqual(['Friendly report']);
        expect(duration.workflowNames).toEqual(['technical-id']);
        expect(duration.fullNames).toEqual(['Friendly report']);
    });
});
