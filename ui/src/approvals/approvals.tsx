import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useContext, useEffect, useState} from 'react';
import {Link, RouteComponentProps} from 'react-router-dom';

import {ApprovalItem, findSuspendedNodes, toApprovalItems} from '../shared/approvals';
import {uiUrl} from '../shared/base';
import {ErrorNotice} from '../shared/components/error-notice';
import {Loading} from '../shared/components/loading';
import {Timestamp} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {Context} from '../shared/context';
import {historyUrl} from '../shared/history';
import {labels} from '../shared/models';
import * as nsUtils from '../shared/namespaces';
import {services} from '../shared/services';
import {useCollectEvent} from '../shared/use-collect-event';

import './approvals.scss';

const REFRESH_INTERVAL_MS = 15000;

// Re-exported for the existing tests.
export {findSuspendedNodes, toApprovalItems};
export type {ApprovalItem};

export function Approvals({match, history}: RouteComponentProps<any>) {
    const {popup} = useContext(Context);
    const [namespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [approvals, setApprovals] = useState<ApprovalItem[]>();
    const [error, setError] = useState<Error>();
    const [busy, setBusy] = useState<string>();
    const [next, setNext] = useState<string>();
    const [page, setPage] = useState<{namespace: string; cursor: string}>();
    const cursor = page?.namespace === namespace ? page.cursor : undefined;
    const [refresh, setRefresh] = useState(0);

    const isFirstRender = React.useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        history.push(historyUrl('approvals' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace}));
    }, [namespace]);

    useEffect(() => {
        let current = true;
        let loading = false;
        function load() {
            if (loading) return;
            loading = true;
            services.workflows
                .runView(namespace, 'gates', cursor)
                .then(list => {
                    if (!current) return;
                    setApprovals(toApprovalItems(list.items || []));
                    setNext(list.metadata?.continue);
                    setError(null);
                })
                .catch(err => current && setError(err))
                .finally(() => (loading = false));
        }
        setApprovals(undefined);
        setNext(undefined);
        load();
        const interval = setInterval(load, REFRESH_INTERVAL_MS);
        return () => {
            current = false;
            clearInterval(interval);
        };
    }, [namespace, cursor, refresh]);

    useCollectEvent('openedApprovals');

    function decide(item: ApprovalItem, decision: 'approve' | 'reject') {
        const {uid} = item.workflow.metadata;
        const {startedAt} = item.node;
        if (!uid || !startedAt) {
            setError(new Error('The gate changed. Refresh and try again.'));
            return;
        }
        const key = `${uid}:${item.node.id}`;
        setBusy(key);
        services.approvals
            .decide(item.workflow.metadata.namespace, item.workflow.metadata.name, item.node.id, {decision, workflowUID: uid, startedAt})
            .then(() => {
                setBusy(undefined);
                setRefresh(value => value + 1);
            })
            .catch(err => {
                setBusy(undefined);
                setError(new Error(err.text || err.message || 'decision failed'));
            });
    }

    function approve(item: ApprovalItem) {
        decide(item, 'approve');
    }

    function reject(item: ApprovalItem) {
        popup
            .confirm('Confirm rejection', `Reject the step "${item.node.displayName || item.node.name}"? Only that step fails; on-exit handlers and later steps still run.`)
            .then(yes => {
                if (!yes) return;
                decide(item, 'reject');
            });
    }

    return (
        <Page
            title='Approvals'
            toolbar={{
                breadcrumbs: [{title: 'Approvals', path: uiUrl('approvals')}, ...(namespace ? [{title: namespace, path: uiUrl('approvals/' + namespace)}] : [])]
            }}>
            <h1 className='modern-visually-hidden'>Approvals</h1>
            <div className='approvals'>
                <p className='approvals__intro'>
                    Runs waiting on a suspended step. Approve to resume the run, or reject to fail that step only (on-exit handlers and later steps still run). Each decision is
                    recorded with who made it (docs/approvals.md).
                </p>
                <ErrorNotice error={error} />
                {!approvals ? (
                    !error && <Loading />
                ) : approvals.length === 0 ? (
                    <ZeroState title={next ? 'No pending approvals on this page' : 'No pending approvals'}>
                        <p>{next ? 'Continue to check older running workflows.' : 'When a run reaches a suspend step that needs your input, it appears here.'}</p>
                    </ZeroState>
                ) : (
                    <div className='argo-table-list approvals__table' role='table' aria-label='Pending approvals'>
                        <div className='row argo-table-list__head' role='row'>
                            <div className='columns small-3' role='columnheader'>
                                RUN
                            </div>
                            <div className='columns small-1' role='columnheader'>
                                NAMESPACE
                            </div>
                            <div className='columns small-2' role='columnheader'>
                                WAITING STEP
                            </div>
                            <div className='columns small-2' role='columnheader'>
                                JOB
                            </div>
                            <div className='columns small-2' role='columnheader'>
                                STARTED
                            </div>
                            <div className='columns small-2' role='columnheader'>
                                ACTIONS
                            </div>
                        </div>
                        {approvals.map(item => {
                            const key = `${item.workflow.metadata.uid}:${item.node.id}`;
                            const job = item.workflow.metadata.labels?.[labels.workflowTemplate] || item.workflow.metadata.labels?.[labels.clusterWorkflowTemplate];
                            return (
                                <div className='row argo-table-list__row' role='row' key={key}>
                                    <div className='columns small-3' role='cell'>
                                        <i className='fa fa-hourglass-half' aria-hidden='true' />{' '}
                                        <Link to={uiUrl(`workflows/${item.workflow.metadata.namespace}/${item.workflow.metadata.name}`)}>{item.workflow.metadata.name}</Link>
                                    </div>
                                    <div className='columns small-1' role='cell'>
                                        {item.workflow.metadata.namespace}
                                    </div>
                                    <div className='columns small-2' role='cell'>
                                        {item.node.displayName || item.node.name}
                                    </div>
                                    <div className='columns small-2' role='cell'>
                                        {job || '-'}
                                    </div>
                                    <div className='columns small-2' role='cell'>
                                        <Timestamp date={item.workflow.status?.startedAt} />
                                    </div>
                                    <div className='columns small-2 approvals__actions' role='cell'>
                                        <button
                                            type='button'
                                            className='argo-button argo-button--base'
                                            disabled={!!busy}
                                            onClick={() => approve(item)}
                                            aria-label={`Approve ${item.node.displayName || item.node.name} on ${item.workflow.metadata.name}`}>
                                            Approve
                                        </button>
                                        <button
                                            type='button'
                                            className='argo-button argo-button--base-o'
                                            disabled={!!busy}
                                            onClick={() => reject(item)}
                                            aria-label={`Reject ${item.node.displayName || item.node.name} on ${item.workflow.metadata.name}`}>
                                            Reject
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                {cursor && (
                    <button className='argo-button argo-button--neutral' onClick={() => setPage(undefined)}>
                        First page
                    </button>
                )}
                {next && (
                    <button className='argo-button argo-button--neutral' onClick={() => setPage({namespace, cursor: next})}>
                        Next page
                    </button>
                )}
            </div>
        </Page>
    );
}
