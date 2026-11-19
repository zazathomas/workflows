import * as React from 'react';
import {useState} from 'react';
import {Link} from 'react-router-dom';

import {ANNOTATION_DESCRIPTION, ANNOTATION_TITLE} from '../shared/annotations';
import {uiUrl} from '../shared/base';
import {PhaseIcon} from '../shared/components/phase-icon';
import {SuspenseReactMarkdownGfm} from '../shared/components/suspense-react-markdown-gfm';
import {Timestamp} from '../shared/components/timestamp';
import {formatDuration, wfDuration} from '../shared/duration';
import {labels as labelKeys, Workflow, WorkflowTemplate} from '../shared/models';
import {services} from '../shared/services';
import {escapeInvalidMarkdown} from '../workflows/utils';

require('./workflow-template-row.scss');

interface WorkflowTemplateRowProps {
    workflow: WorkflowTemplate;
    displayISOFormat: boolean;
    clusterScoped?: boolean;
    targetNamespace?: string;
}

/** The label selector that finds the runs of a Job. */
export function runsLabelSelector(clusterScoped: boolean, name: string): string {
    return `${clusterScoped ? labelKeys.clusterWorkflowTemplate : labelKeys.workflowTemplate}=${name}`;
}

export function WorkflowTemplateRow(props: WorkflowTemplateRowProps) {
    const wf = props.workflow;
    // title + description vars
    const title = (wf.metadata.annotations?.[ANNOTATION_TITLE] && `${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_TITLE])}`) ?? wf.metadata.name;
    const description = (wf.metadata.annotations?.[ANNOTATION_DESCRIPTION] && `\n\n${escapeInvalidMarkdown(wf.metadata.annotations[ANNOTATION_DESCRIPTION])}`) || '';
    const markdown = `${title}${description}`;
    const detailPath = props.clusterScoped ? uiUrl(`cluster-workflow-templates/${wf.metadata.name}`) : uiUrl(`workflow-templates/${wf.metadata.namespace}/${wf.metadata.name}`);
    const submitSearch = props.clusterScoped
        ? `?${new URLSearchParams({sidePanel: 'true', ...(props.targetNamespace ? {namespace: props.targetNamespace} : {})})}`
        : '?sidePanel=submit';

    // Semaphore-style expandable rows: the latest runs of the template, loaded lazily
    const [expanded, setExpanded] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [recentRuns, setRecentRuns] = useState<Workflow[]>();

    function toggleExpanded() {
        const next = !expanded;
        setExpanded(next);
        if (next && !loaded) {
            setLoaded(true);
            services.workflows
                .list(props.targetNamespace || wf.metadata.namespace, [], [runsLabelSelector(!!props.clusterScoped, wf.metadata.name)], {limit: 5})
                .then(list => {
                    const runs = [...(list.items || [])].sort((a, b) => new Date(b.status?.startedAt || 0).getTime() - new Date(a.status?.startedAt || 0).getTime());
                    setRecentRuns(runs);
                })
                .catch(() => setRecentRuns([]));
        }
    }

    return (
        <div className='workflow-templates-list__row-container' role='rowgroup'>
            <div className='row argo-table-list__row' role='row'>
                <div className='columns small-1 workflow-templates-list__expand'>
                    <button
                        type='button'
                        className='workflow-templates-list__expand-button'
                        aria-expanded={expanded}
                        aria-label={expanded ? `Hide recent runs of ${wf.metadata.name}` : `Show recent runs of ${wf.metadata.name}`}
                        onClick={toggleExpanded}>
                        <i className={`fas ${expanded ? 'fa-caret-down' : 'fa-caret-right'}`} aria-hidden='true' />
                    </button>
                </div>
                <Link to={{pathname: detailPath}} className='columns small-5 workflow-templates-list__name' role='rowheader' aria-valuetext={markdown}>
                    <span className='workflow-templates-list__badge'>{props.clusterScoped ? 'Cluster' : 'Namespace'}</span>
                    <div className='wf-rows-name'>
                        <SuspenseReactMarkdownGfm markdown={title} />
                    </div>
                    {description && <div className='workflow-templates-list__description'>{description.trim()}</div>}
                </Link>
                <div className='columns small-2' role='cell'>
                    {props.clusterScoped ? 'All namespaces' : wf.metadata.namespace}
                    <div>
                        {wf.metadata.labels?.team ? (
                            <span className='workflow-templates-list__team'>{wf.metadata.labels.team}</span>
                        ) : (
                            <span className='workflow-templates-list__team workflow-templates-list__team--none'>No team</span>
                        )}
                    </div>
                </div>
                <div className='columns small-2' role='cell'>
                    <Timestamp date={wf.metadata.creationTimestamp} displayISOFormat={props.displayISOFormat} />
                </div>
                <div className='columns small-2' role='cell'>
                    <Link
                        className='argo-button argo-button--base-o'
                        aria-label={`${props.clusterScoped ? 'Run cluster job' : 'Run job'} ${wf.metadata.name}`}
                        to={{pathname: detailPath, search: submitSearch}}>
                        Run job
                    </Link>
                </div>
            </div>
            {expanded && (
                <div className='workflow-templates-list__recent-runs' role='rowgroup' aria-label={`Recent runs of ${wf.metadata.name}`}>
                    {!recentRuns ? (
                        <span className='workflow-templates-list__recent-runs-loading'>Loading recent runs…</span>
                    ) : recentRuns.length === 0 ? (
                        <span className='workflow-templates-list__recent-runs-empty'>No runs yet.</span>
                    ) : (
                        recentRuns.map(run => (
                            <div className='workflow-templates-list__recent-run' key={run.metadata.uid}>
                                <PhaseIcon value={run.status?.phase} />
                                <Link to={uiUrl(`workflows/${run.metadata.namespace}/${run.metadata.name}?uid=${run.metadata.uid}`)}>{run.metadata.name}</Link>
                                <span className='workflow-templates-list__recent-run-detail'>{formatDuration(wfDuration(run.status))}</span>
                                <span className='workflow-templates-list__recent-run-detail'>
                                    <Timestamp date={run.status?.startedAt} compact />
                                </span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
