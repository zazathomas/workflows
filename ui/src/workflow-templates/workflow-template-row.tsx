import * as React from 'react';
import {Link} from 'react-router-dom';

import {ANNOTATION_DESCRIPTION, ANNOTATION_TITLE} from '../shared/annotations';
import {uiUrl} from '../shared/base';
import {SuspenseReactMarkdownGfm} from '../shared/components/suspense-react-markdown-gfm';
import {Timestamp} from '../shared/components/timestamp';
import {WorkflowTemplate} from '../shared/models';
import {escapeInvalidMarkdown} from '../workflows/utils';

require('./workflow-template-row.scss');

interface WorkflowTemplateRowProps {
    workflow: WorkflowTemplate;
    displayISOFormat: boolean;
    clusterScoped?: boolean;
    targetNamespace?: string;
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

    return (
        <div className='workflow-templates-list__row-container' role='rowgroup'>
            <div className='row argo-table-list__row' role='row'>
                <Link to={{pathname: detailPath}} className='columns small-6 workflow-templates-list__name' role='rowheader' aria-valuetext={markdown}>
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
        </div>
    );
}
