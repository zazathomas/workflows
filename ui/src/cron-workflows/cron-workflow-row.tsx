import {Ticker} from 'argo-ui/src/index';
import * as React from 'react';
import {Link} from 'react-router-dom';

import {ANNOTATION_DESCRIPTION, ANNOTATION_TITLE} from '../shared/annotations';
import {uiUrl} from '../shared/base';
import {ErrorIcon} from '../shared/components/fa-icons';
import {SuspenseReactMarkdownGfm} from '../shared/components/suspense-react-markdown-gfm';
import {Timestamp} from '../shared/components/timestamp';
import {getErrorCondition} from '../shared/conditions-panel';
import {getNextScheduledTime} from '../shared/cron';
import {CronWorkflow, CronWorkflowSpec} from '../shared/models';
import {escapeInvalidMarkdown} from '../workflows/utils';
import {PrettySchedule} from './pretty-schedule';

require('./cron-workflow-row.scss');

interface CronWorkflowRowProps {
    workflow: CronWorkflow;
    displayISOFormatCreation: boolean;
    displayISOFormatNextScheduled: boolean;
}

export function CronWorkflowRow(props: CronWorkflowRowProps) {
    const wf = props.workflow;
    // title + description vars
    const title = (wf.metadata.annotations?.[ANNOTATION_TITLE] && `${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_TITLE])}`) ?? wf.metadata.name;
    const description = (wf.metadata.annotations?.[ANNOTATION_DESCRIPTION] && `\n${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_DESCRIPTION])}`) || '';
    const markdown = `${title}${description}`;
    const errorCondition = getErrorCondition(wf.status?.conditions || []);

    return (
        <div className='cron-workflows-list__row-container'>
            <div className='row argo-table-list__row'>
                <div className='columns small-1'>
                    {errorCondition ? (
                        <span title={errorCondition.message}>
                            <ErrorIcon />
                        </span>
                    ) : wf.spec.suspend ? (
                        <i className='fa fa-pause' />
                    ) : (
                        <i className='fa fa-clock' />
                    )}
                </div>
                <Link to={{pathname: uiUrl(`cron-workflows/${wf.metadata.namespace}/${wf.metadata.name}`)}} className='columns small-2'>
                    <div className={description.length ? 'wf-rows-name' : ''} aria-valuetext={markdown}>
                        <SuspenseReactMarkdownGfm markdown={markdown} />
                    </div>
                    <span>{errorCondition ? 'Error' : wf.spec.suspend ? 'Suspended' : 'Active'}</span>
                </Link>
                <div className='columns small-2'>{wf.metadata.namespace}</div>
                <div className='columns small-1'>{wf.spec.timezone || 'UTC (estimated)'}</div>
                <div className='columns small-2 cron-workflow-schedules'>
                    {(wf.spec.schedules || []).map((schedule, index) => (
                        <div className='cron-workflow-schedules__item' key={`${schedule}-${index}`}>
                            <PrettySchedule schedule={schedule} />
                            <code>{schedule}</code>
                        </div>
                    ))}
                </div>
                <div className='columns small-2'>
                    <Timestamp date={wf.metadata.creationTimestamp} displayISOFormat={props.displayISOFormatCreation} />
                </div>
                <div className='columns small-2'>
                    {wf.spec.suspend ? (
                        'Suspended'
                    ) : (
                        <Ticker intervalMs={1000}>
                            {() => {
                                const next = getCronNextScheduledTime(wf.spec);
                                return next ? <Timestamp date={next} displayISOFormat={props.displayISOFormatNextScheduled} /> : 'Unavailable';
                            }}
                        </Ticker>
                    )}
                </div>
            </div>
        </div>
    );
}

export function getCronNextScheduledTime(spec: CronWorkflowSpec): Date {
    let out: Date;
    (spec.schedules || []).forEach(schedule => {
        const next = getNextScheduledTime(schedule, spec.timezone);
        if (next && (!out || next.getTime() < out.getTime())) {
            out = next;
        }
    });
    return out;
}
