import parser from 'cron-parser';

export function getNextScheduledTime(schedule: string, tz: string): Date {
    let out: Date;
    try {
        out = parser.parseExpression(schedule, {utc: !tz, tz}).next().toDate();
    } catch (e) {
        // Do nothing
    }
    return out;
}

/** The next `count` run times of a schedule, soonest first. */
export function getNextScheduledTimes(schedule: string, tz: string, count: number): Date[] {
    const out: Date[] = [];
    try {
        const interval = parser.parseExpression(schedule, {utc: !tz, tz});
        for (let i = 0; i < count; i++) {
            out.push(interval.next().toDate());
        }
    } catch (e) {
        // An invalid schedule yields no upcoming runs.
    }
    return out;
}
