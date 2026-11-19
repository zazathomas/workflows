import {fireEvent, render, screen, within} from '@testing-library/react';
import * as React from 'react';
import {MemoryRouter} from 'react-router-dom';

import {Condition, CronWorkflow} from '../shared/models';
import {CronWorkflowRow} from './cron-workflow-row';

function workflow(conditions?: Condition[], suspend = false): CronWorkflow {
    return {
        metadata: {
            name: 'my-cron-workflow',
            namespace: 'default'
        },
        spec: {
            schedules: ['0 * * * *'],
            suspend,
            workflowSpec: {}
        },
        status: conditions
            ? {
                  active: [],
                  conditions,
                  lastScheduledTime: null
              }
            : undefined
    };
}

function renderRow(cronWorkflow: CronWorkflow) {
    return render(
        <MemoryRouter>
            <CronWorkflowRow workflow={cronWorkflow} displayISOFormatCreation={false} displayISOFormatNextScheduled={false} />
        </MemoryRouter>
    );
}

describe('CronWorkflowRow', () => {
    it('groups each human-readable schedule with its cron expression', () => {
        const cronWorkflow = workflow();
        cronWorkflow.spec.schedules = ['0 * * * *', '0 9 * * *'];
        renderRow(cronWorkflow);

        const hourly = screen.getByText('Every hour').parentElement;
        const daily = screen.getByText('At 09:00 AM').parentElement;
        expect(within(hourly).getByText('0 * * * *')).toBeInTheDocument();
        expect(within(daily).getByText('0 9 * * *')).toBeInTheDocument();
        expect(hourly.parentElement).toBe(daily.parentElement);
    });

    it('keeps unsupported and invalid expressions visible with a fallback', () => {
        const cronWorkflow = workflow(undefined, true);
        cronWorkflow.spec.schedules = ['@every 5m', 'bad cron'];
        renderRow(cronWorkflow);

        const unavailable = screen.getAllByText('Description unavailable');
        expect(within(unavailable[0].parentElement).getByText('@every 5m')).toBeInTheDocument();
        expect(within(unavailable[1].parentElement).getByText('bad cron')).toBeInTheDocument();
    });

    it('shows an error icon and condition message for an error condition', () => {
        renderRow(
            workflow([
                {
                    type: 'SpecError',
                    status: 'True',
                    message: "template name 'missing' undefined"
                }
            ])
        );

        const error = screen.getByTitle("template name 'missing' undefined");
        expect(error.querySelector('.status-icon--failed')).toBeInTheDocument();
    });

    it('shows the running phase icon when there are no error conditions', () => {
        const {container} = renderRow(workflow());

        expect(container.querySelector('.status-icon--running')).toBeInTheDocument();
        expect(container.querySelector('.status-icon--failed')).not.toBeInTheDocument();
    });

    it('keeps the neutral phase icon for a suspended workflow without errors', () => {
        const {container} = renderRow(workflow(undefined, true));

        // Suspended schedules fall back to the shared phase icon's neutral
        // clock styling (one status-icon vocabulary everywhere).
        expect(container.querySelector('.status-icon--init')).toBeInTheDocument();
        expect(container.querySelector('.status-icon--failed')).not.toBeInTheDocument();
    });

    it('shows the last scheduled run and links to the runs of the schedule', () => {
        const cronWorkflow = workflow();
        cronWorkflow.status = {active: [], conditions: [], lastScheduledTime: '2024-05-01T00:00:00Z'};
        renderRow(cronWorkflow);

        const lastRun = screen.getByTitle('Show the runs started by this schedule');
        expect(lastRun).toHaveAttribute('href', expect.stringContaining('label=workflows.argoproj.io/cron-workflow=my-cron-workflow'));
    });

    it('shows Never when no run has been recorded', () => {
        renderRow(workflow());
        expect(screen.getByTitle('No run recorded yet')).toBeInTheDocument();
    });

    it('runs the schedule now through the provided callback', () => {
        const onRunNow = jest.fn();
        render(
            <MemoryRouter>
                <CronWorkflowRow workflow={workflow()} displayISOFormatCreation={false} displayISOFormatNextScheduled={false} onRunNow={onRunNow} />
            </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', {name: 'Run schedule my-cron-workflow now'}));
        expect(onRunNow).toHaveBeenCalledWith(expect.objectContaining({metadata: expect.objectContaining({name: 'my-cron-workflow'})}));
    });

    it('disables run now for a suspended schedule', () => {
        render(
            <MemoryRouter>
                <CronWorkflowRow workflow={workflow(undefined, true)} displayISOFormatCreation={false} displayISOFormatNextScheduled={false} onRunNow={jest.fn()} />
            </MemoryRouter>
        );
        expect(screen.getByRole('button', {name: 'Run schedule my-cron-workflow now'})).toBeDisabled();
    });
});
