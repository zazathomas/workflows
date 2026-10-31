import {CronWorkflow} from '../shared/models';
import {filterSchedulesByState} from './cron-workflow-list';
import {getCronNextScheduledTime} from './cron-workflow-row';

describe('schedule list', () => {
    it('filters active and suspended schedules, including an empty selection', () => {
        const active = {spec: {suspend: false}} as CronWorkflow;
        const suspended = {spec: {suspend: true}} as CronWorkflow;
        const schedules = [active, suspended];
        expect(filterSchedulesByState(schedules, ['Running'])).toEqual([active]);
        expect(filterSchedulesByState(schedules, ['Suspended'])).toEqual([suspended]);
        expect(filterSchedulesByState(schedules, [])).toEqual([]);
    });

    it('ignores invalid schedules when calculating the next run', () => {
        expect(getCronNextScheduledTime({schedules: ['invalid', '0 * * * *'], timezone: 'UTC'} as any)).toBeInstanceOf(Date);
        expect(getCronNextScheduledTime({schedules: ['invalid'], timezone: 'UTC'} as any)).toBeUndefined();
        expect(getCronNextScheduledTime({} as any)).toBeUndefined();
    });
});
