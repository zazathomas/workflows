import {render, screen, within} from '@testing-library/react';
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
        const {container} = renderRow(
            workflow([
                {
                    type: 'SpecError',
                    status: 'True',
                    message: "template name 'missing' undefined"
                }
            ])
        );

        const error = screen.getByTitle("template name 'missing' undefined");
        expect(error.querySelector('.status-icon--error')).toBeInTheDocument();
        expect(container.querySelector('.fa-clock')).not.toBeInTheDocument();
    });

    it('shows the clock icon when there are no error conditions', () => {
        const {container} = renderRow(workflow());

        expect(container.querySelector('.fa-clock')).toBeInTheDocument();
        expect(container.querySelector('.status-icon--error')).not.toBeInTheDocument();
    });

    it('keeps the pause icon for a suspended workflow without errors', () => {
        const {container} = renderRow(workflow(undefined, true));

        expect(container.querySelector('.fa-pause')).toBeInTheDocument();
        expect(container.querySelector('.status-icon--error')).not.toBeInTheDocument();
    });
});
