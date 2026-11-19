import {Ticker} from 'argo-ui/src/components/ticker';
import * as React from 'react';
import {useState} from 'react';
import {Link} from 'react-router-dom';

import {ANNOTATION_DESCRIPTION, ANNOTATION_TITLE} from '../../../shared/annotations';
import {uiUrl} from '../../../shared/base';
import {DurationPanel} from '../../../shared/components/duration-panel';
import {PhaseIcon} from '../../../shared/components/phase-icon';
import {SuspenseReactMarkdownGfm} from '../../../shared/components/suspense-react-markdown-gfm';
import {Timestamp} from '../../../shared/components/timestamp';
import {Tooltip} from '../../../shared/components/tooltip';
import {wfDuration} from '../../../shared/duration';
import * as models from '../../../shared/models';
import {isArchivedWorkflow, Workflow} from '../../../shared/models';
import {services} from '../../../shared/services';
import {getStartedBy, StartedBy} from '../../../shared/started-by';
import {escapeInvalidMarkdown} from '../../utils';
import {WorkflowDrawer} from '../workflow-drawer/workflow-drawer';
import {OptionalColumn} from '../workflows-list/table-options';

require('./workflows-row.scss');

interface WorkflowsRowProps {
    workflow: Workflow;
    onChange: (key: string) => void;
    select: (wf: Workflow) => void;
    checked: boolean;
    columns: models.Column[];
    displayISOFormatStart: boolean;
    displayISOFormatFinished: boolean;
    visibleColumns?: OptionalColumn[];
}

export function WorkflowsRow(props: WorkflowsRowProps) {
    const [hideDrawer, setHideDrawer] = useState(true);
    const wf = props.workflow;
    const show = (column: OptionalColumn) => !props.visibleColumns || props.visibleColumns.includes(column);
    const title = (wf.metadata.annotations?.[ANNOTATION_TITLE] && `${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_TITLE])}`) ?? wf.metadata.name;
    const description = (wf.metadata.annotations?.[ANNOTATION_DESCRIPTION] && `\n${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_DESCRIPTION])}`) || '';
    const hasAnnotation = title !== wf.metadata.name || description !== '';
    const markdown = `${title}${description}`;
    const workflowUrl = {
        pathname: uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}`),
        search: `?uid=${wf.metadata.uid}`
    };

    function toggleDrawer() {
        setHideDrawer(value => !value);
    }

    function renderDuration() {
        return <Ticker>{() => <DurationPanel phase={wf.status.phase} duration={wfDuration(wf.status)} estimatedDuration={wf.status.estimatedDuration} />}</Ticker>;
    }

    function copyUrl() {
        const url = `${window.location.origin}${uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}`)}?uid=${wf.metadata.uid}`;
        navigator.clipboard?.writeText(url);
    }

    function stopRun() {
        services.workflows.stop(wf.metadata.name, wf.metadata.namespace).catch(() => {
            // Stop failures surface on the run's detail page; the row stays as-is.
        });
    }

    function deleteRun() {
        services.workflows.delete(wf.metadata.name, wf.metadata.namespace).catch(() => {
            // Delete failures surface on the run's detail page.
        });
    }

    /** AWX/Rundeck-style row actions: share the run, stop it while running, delete it when done. */
    function renderQuickActions() {
        const running = wf.status?.phase === 'Running' || wf.status?.phase === 'Pending';
        const terminal = ['Succeeded', 'Failed', 'Error'].includes(wf.status?.phase);
        return (
            <div className='workflows-row__quick-actions'>
                <button
                    type='button'
                    className='workflows-row__quick-action'
                    aria-label={`Copy link to run ${wf.metadata.name}`}
                    title='Copy link to this run'
                    onClick={e => {
                        e.stopPropagation();
                        copyUrl();
                    }}>
                    <i className='fa fa-link' aria-hidden='true' />
                </button>
                {running && (
                    <button
                        type='button'
                        className='workflows-row__quick-action'
                        aria-label={`Stop run ${wf.metadata.name}`}
                        title='Stop this run'
                        onClick={e => {
                            e.stopPropagation();
                            stopRun();
                        }}>
                        <i className='fa fa-stop-circle' aria-hidden='true' />
                    </button>
                )}
                {terminal && (
                    <button
                        type='button'
                        className='workflows-row__quick-action'
                        aria-label={`Delete run ${wf.metadata.name}`}
                        title='Delete this run'
                        onClick={e => {
                            e.stopPropagation();
                            deleteRun();
                        }}>
                        <i className='fa fa-trash' aria-hidden='true' />
                    </button>
                )}
            </div>
        );
    }

    function renderStartedBy(startedBy: StartedBy) {
        if (startedBy.kind === 'unknown') {
            return <span className='workflows-row__started-by--unknown'>-</span>;
        }
        return (
            <span className='workflows-row__started-by'>
                <Tooltip content={`Started by ${startedBy.name}`}>
                    <span>
                        <i className={startedBy.icon} aria-hidden='true' /> {startedBy.name}
                    </span>
                </Tooltip>
            </span>
        );
    }

    return (
        <div className='workflows-list__row-container' role='rowgroup'>
            <div className='row argo-table-list__row workflows-row__desktop' role='row'>
                <div className='columns small-1 workflows-list__status' data-testid='workflow-status' role='cell'>
                    <input
                        type='checkbox'
                        aria-label={`Select workflow ${wf.metadata.name}`}
                        className='workflows-list__status--checkbox'
                        checked={props.checked}
                        onClick={e => e.stopPropagation()}
                        onChange={() => props.select(props.workflow)}
                    />
                    <PhaseIcon value={wf.status.phase} />
                </div>
                <div className='small-11 row'>
                    <Link to={workflowUrl} className='columns small-2' role='rowheader'>
                        <div className={description.length ? 'wf-rows-name' : ''} aria-valuetext={markdown}>
                            <SuspenseReactMarkdownGfm markdown={markdown} />
                        </div>
                        <span className='workflows-row__phase'>{wf.status.phase || 'Unknown'}</span>
                    </Link>
                    {show('namespace') && (
                        <div className='columns small-1' role='cell'>
                            {wf.metadata.namespace}
                        </div>
                    )}
                    {show('started') && (
                        <div className='columns small-1 workflows-list__timestamp' role='cell'>
                            <Timestamp date={wf.status.startedAt} displayISOFormat={props.displayISOFormatStart} compact />
                        </div>
                    )}
                    {show('finished') && (
                        <div className='columns small-1 workflows-list__timestamp' role='cell'>
                            <Timestamp date={wf.status.finishedAt} displayISOFormat={props.displayISOFormatFinished} compact />
                        </div>
                    )}
                    {show('duration') && (
                        <div className='columns small-1' role='cell'>
                            {renderDuration()}
                        </div>
                    )}
                    {show('progress') && (
                        <div className='columns small-1' role='cell'>
                            {wf.status.progress || '-'}
                        </div>
                    )}
                    {show('message') && (
                        <div className='columns small-2' role='cell' title={wf.status.message || undefined}>
                            {wf.status.message || '-'}
                        </div>
                    )}
                    {show('details') && (
                        <div className='columns small-1' role='cell'>
                            <button
                                type='button'
                                className='workflows-row__action'
                                aria-expanded={!hideDrawer}
                                aria-label={hideDrawer ? `Show details for ${wf.metadata.name}` : `Hide details for ${wf.metadata.name}`}
                                onClick={toggleDrawer}>
                                {hideDrawer ? 'Show' : 'Hide'} <i className={`fas ${hideDrawer ? 'fa-caret-down' : 'fa-caret-up'}`} aria-hidden='true' />
                            </button>
                        </div>
                    )}
                    {show('archived') && (
                        <div className='columns small-1' role='cell'>
                            {isArchivedWorkflow(wf) ? 'Yes' : 'No'}
                        </div>
                    )}
                    {show('details') && (
                        <div className='columns small-1 workflows-row__quick-actions-cell' role='cell'>
                            {renderQuickActions()}
                        </div>
                    )}
                    {show('startedBy') && (
                        <div className='columns small-1' role='cell'>
                            {renderStartedBy(getStartedBy(wf))}
                        </div>
                    )}
                    {(props.columns || []).map(column => {
                        const value = (column.type === 'label' ? wf?.metadata?.labels?.[column.key] : wf?.metadata?.annotations?.[column.key]) ?? 'unknown';
                        return (
                            <div key={column.name} className='columns small-1' role='cell'>
                                {value}
                            </div>
                        );
                    })}
                </div>
            </div>

            <article className='workflows-row__mobile-card' aria-label={`${wf.metadata.name}, ${wf.status.phase}`}>
                <div className='workflows-row__mobile-header'>
                    <div className='workflows-row__mobile-title'>
                        <PhaseIcon value={wf.status.phase} />
                        <Link to={workflowUrl}>{wf.metadata.name}</Link>
                        <span className='workflows-row__phase'>{wf.status.phase || 'Unknown'}</span>
                    </div>
                    <input type='checkbox' aria-label={`Select workflow ${wf.metadata.name}`} checked={props.checked} onChange={() => props.select(props.workflow)} />
                </div>
                <p className='workflows-row__mobile-message'>{wf.status.message || 'No status message'}</p>
                <dl className='workflows-row__mobile-metadata'>
                    <div>
                        <dt>Namespace</dt>
                        <dd>{wf.metadata.namespace}</dd>
                    </div>
                    <div>
                        <dt>Started</dt>
                        <dd>
                            <Timestamp date={wf.status.startedAt} displayISOFormat={props.displayISOFormatStart} compact />
                        </dd>
                    </div>
                    <div>
                        <dt>Duration</dt>
                        <dd>{renderDuration()}</dd>
                    </div>
                    <div>
                        <dt>Progress</dt>
                        <dd>{wf.status.progress || '-'}</dd>
                    </div>
                    <div>
                        <dt>Archived</dt>
                        <dd>{isArchivedWorkflow(wf) ? 'Yes' : 'No'}</dd>
                    </div>
                    <div>
                        <dt>Started by</dt>
                        <dd>
                            <i className={getStartedBy(wf).icon} aria-hidden='true' /> {getStartedBy(wf).name || '-'}
                        </dd>
                    </div>
                </dl>
                <div className='workflows-row__mobile-actions'>
                    <Link className='argo-button argo-button--base-o' to={workflowUrl}>
                        Open workflow
                    </Link>
                    <button type='button' className='argo-button argo-button--base-o' aria-expanded={!hideDrawer} onClick={toggleDrawer}>
                        {hideDrawer ? 'Show details' : 'Hide details'}
                    </button>
                </div>
            </article>

            {!hideDrawer && (
                <WorkflowDrawer
                    description={wf.metadata.annotations?.[ANNOTATION_DESCRIPTION]}
                    hasAnnotation={hasAnnotation}
                    name={wf.metadata.name}
                    namespace={wf.metadata.namespace}
                    onChange={props.onChange}
                    title={wf.metadata.annotations?.[ANNOTATION_TITLE]}
                />
            )}
        </div>
    );
}
