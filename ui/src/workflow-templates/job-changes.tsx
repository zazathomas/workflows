import * as kubernetes from 'argo-ui/src/models/kubernetes';
import * as React from 'react';

import {Timestamp} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {changeAction, changeHistory, lastChange} from '../shared/managed-fields';

import './job-changes.scss';

/**
 * AWX-style activity view for one object: the managedFields entries the API
 * server records when a client writes the object. A poor-man's audit trail
 * until the server gains an events API.
 */
export function JobChanges({object}: {object: {metadata?: kubernetes.ObjectMeta}}) {
    const changes = changeHistory(object);
    const latest = lastChange(changes);
    const createdAt = object?.metadata?.creationTimestamp;

    if (changes.length === 0) {
        return (
            <ZeroState title='No change history'>
                <p>
                    This server does not report {object?.metadata?.name ? `changes to "${object.metadata.name}"` : 'changes'} for this object. That happens when the object is
                    served by a version that strips Kubernetes managed fields.
                </p>
            </ZeroState>
        );
    }

    return (
        <div className='job-changes'>
            <div className='job-changes__stats' role='group' aria-label='Object change summary'>
                <span className='job-changes__tile'>
                    <span className='job-changes__value'>{latest?.manager || 'unknown'}</span>
                    <span className='job-changes__label'>Last changed by</span>
                </span>
                <span className='job-changes__tile'>
                    <span className='job-changes__value'>{latest?.time ? <Timestamp date={latest.time} /> : 'not reported'}</span>
                    <span className='job-changes__label'>Last change</span>
                </span>
                <span className='job-changes__tile'>
                    <span className='job-changes__value'>{createdAt ? <Timestamp date={createdAt} /> : '-'}</span>
                    <span className='job-changes__label'>Created</span>
                </span>
                <span className='job-changes__tile'>
                    <span className='job-changes__value'>{object?.metadata?.generation ?? '-'}</span>
                    <span className='job-changes__label'>Generation</span>
                </span>
            </div>
            <p className='job-changes__intro'>
                Kubernetes records one entry per client that wrote this object; the most recent first. This comes from <code>metadata.managedFields</code> and is not a full audit
                log: changes made outside the Kubernetes API do not appear here.
            </p>
            <div className='argo-table-list job-changes__table' role='table' aria-label='Object change history'>
                <div className='row argo-table-list__head' role='row'>
                    <div className='columns small-2' role='columnheader'>
                        WHEN
                    </div>
                    <div className='columns small-4' role='columnheader'>
                        CHANGED BY
                    </div>
                    <div className='columns small-2' role='columnheader'>
                        ACTION
                    </div>
                    <div className='columns small-2' role='columnheader'>
                        SUBRESOURCE
                    </div>
                    <div className='columns small-2' role='columnheader'>
                        API VERSION
                    </div>
                </div>
                {changes.map((change, index) => (
                    <div className='row argo-table-list__row' role='row' key={`${change.manager || 'unknown'}:${change.time || ''}:${index}`}>
                        <div className='columns small-2' role='cell'>
                            {change.time ? <Timestamp date={change.time} /> : 'not reported'}
                        </div>
                        <div className='columns small-4' role='cell'>
                            {change.manager || 'unknown'}
                        </div>
                        <div className='columns small-2' role='cell'>
                            {changeAction(change)}
                        </div>
                        <div className='columns small-2' role='cell'>
                            {change.subresource || '-'}
                        </div>
                        <div className='columns small-2' role='cell'>
                            {change.apiVersion || '-'}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
