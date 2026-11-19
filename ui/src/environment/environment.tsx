import {Page} from 'argo-ui/src/components/page/page';
import * as React from 'react';
import {useEffect, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router';

import {uiUrl} from '../shared/base';
import {ClipboardText} from '../shared/components/clipboard-text';
import {ErrorNotice} from '../shared/components/error-notice';
import {Loading} from '../shared/components/loading';
import {NamespaceFilter} from '../shared/components/namespace-filter';
import {Timestamp} from '../shared/components/timestamp';
import {ZeroState} from '../shared/components/zero-state';
import {historyUrl} from '../shared/history';
import * as nsUtils from '../shared/namespaces';
import {services} from '../shared/services';
import {EnvironmentListing, EnvironmentResource} from '../shared/services/environment-service';
import {useCollectEvent} from '../shared/use-collect-event';

import './environment.scss';

/**
 * Environment viewer (Semaphore "Key Store" shape): the ConfigMaps and
 * Secrets of a namespace with their key names. The server never sends values,
 * so everything on this page is masked by construction.
 */
export function Environment({match, history}: RouteComponentProps<any>) {
    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [listing, setListing] = useState<EnvironmentListing>();
    const [error, setError] = useState<Error>();
    const [filter, setFilter] = useState('');
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        history.push(historyUrl('environment' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace}));
    }, [namespace]);

    useEffect(() => {
        let disposed = false;
        setListing(undefined);
        setError(undefined);
        if (!namespace) {
            return;
        }
        services.environment
            .metadata(namespace)
            .then(result => {
                if (!disposed) setListing(result);
            })
            .catch(err => {
                if (!disposed) setError(new Error(err.text || err.message || 'failed to load the environment'));
            });
        return () => {
            disposed = true;
        };
    }, [namespace, reloadKey]);

    useCollectEvent('openedEnvironment');

    const query = filter.trim().toLowerCase();
    const matches = (resource: EnvironmentResource) => {
        if (!query) return true;
        return resource.name.toLowerCase().includes(query) || resource.keys?.some(key => key.name.toLowerCase().includes(query));
    };
    const configMaps = (listing?.configMaps || []).filter(matches);
    const secrets = (listing?.secrets || []).filter(matches);
    const total = (listing?.configMaps?.length || 0) + (listing?.secrets?.length || 0);

    function more(kind: EnvironmentResource['kind'], cursor: string) {
        const field = kind === 'ConfigMap' ? 'configMaps' : 'secrets';
        const cursorField = kind === 'ConfigMap' ? 'configMapCursor' : 'secretCursor';
        services.environment
            .page(namespace, kind, cursor)
            .then(result => {
                setListing(current =>
                    current?.namespace === namespace && current[cursorField] === cursor
                        ? {...current, [field]: [...current[field], ...result.items], [cursorField]: result.continue}
                        : current
                );
            })
            .catch(err => setError(new Error(err.text || err.message || 'failed to load the next page')));
    }

    function details(resource: EnvironmentResource) {
        const field = resource.kind === 'ConfigMap' ? 'configMaps' : 'secrets';
        services.environment
            .details(namespace, resource.kind, resource.name)
            .then(result => {
                setListing(current =>
                    current?.namespace === namespace ? {...current, [field]: current[field].map(item => (item.name === result.name ? result : item))} : current
                );
            })
            .catch(err => setError(new Error(err.text || err.message || 'failed to load keys')));
    }

    return (
        <Page
            title='Environment'
            toolbar={{
                breadcrumbs: [{title: 'Environment', path: uiUrl('environment')}, ...(namespace ? [{title: namespace, path: uiUrl('environment/' + namespace)}] : [])],
                actionMenu: {
                    items: [
                        {
                            title: 'Refresh',
                            iconClassName: 'fa fa-sync',
                            action: () => setReloadKey(key => key + 1)
                        }
                    ]
                }
            }}>
            <h1 className='modern-visually-hidden'>Environment</h1>
            <div className='environment'>
                <div className='environment__filters'>
                    <label htmlFor='environment-namespace'>Namespace</label>{' '}
                    <NamespaceFilter id='environment-namespace' ariaLabel='Environment namespace' value={namespace} onChange={setNamespace} />
                    <label htmlFor='environment-filter'>Filter</label>{' '}
                    <input
                        id='environment-filter'
                        className='argo-field'
                        placeholder='ConfigMap, Secret or key name'
                        value={filter}
                        onChange={event => setFilter(event.target.value)}
                    />
                </div>
                <p className='environment__intro'>
                    <i className='fa fa-lock' aria-hidden='true' /> Values are masked: argo-server lists names, key names and sizes only, using your own Kubernetes permissions.
                </p>
                <ErrorNotice error={error} />
                {!namespace ? (
                    <ZeroState title='Choose a namespace'>
                        <p>Pick a namespace to list the ConfigMaps and Secrets its jobs can reference.</p>
                    </ZeroState>
                ) : !listing ? (
                    !error && <Loading />
                ) : (
                    <>
                        {listing.errors?.map(message => (
                            <p className='environment__warning' key={message}>
                                <i className='fa fa-exclamation-triangle' aria-hidden='true' /> {message}
                            </p>
                        ))}
                        {total === 0 ? (
                            <ZeroState title='No ConfigMaps or Secrets'>
                                <p>This namespace is empty, or its resources are not visible to you.</p>
                            </ZeroState>
                        ) : (
                            <>
                                <ResourceTable
                                    title='ConfigMaps'
                                    resources={configMaps}
                                    total={listing.configMaps?.length || 0}
                                    more={listing.configMapCursor ? () => more('ConfigMap', listing.configMapCursor) : undefined}
                                    onDetails={details}
                                    emptyMessage='No ConfigMaps match the filter.'
                                />
                                <ResourceTable
                                    title='Secrets'
                                    resources={secrets}
                                    total={listing.secrets?.length || 0}
                                    more={listing.secretCursor ? () => more('Secret', listing.secretCursor) : undefined}
                                    onDetails={details}
                                    emptyMessage='No Secrets match the filter.'
                                    showType={true}
                                />
                            </>
                        )}
                    </>
                )}
            </div>
        </Page>
    );
}

function ResourceTable({
    title,
    resources,
    total,
    more,
    onDetails,
    emptyMessage,
    showType
}: {
    title: string;
    resources: EnvironmentResource[];
    total: number;
    more?: () => void;
    onDetails: (resource: EnvironmentResource) => void;
    emptyMessage: string;
    showType?: boolean;
}) {
    return (
        <section className='environment__section' aria-label={title}>
            <h2>
                {title} <span className='environment__count'>{resources.length === total ? total : `${resources.length} of ${total}`}</span>
            </h2>
            <div className='argo-table-list environment__table' role='table' aria-label={title}>
                <div className='row argo-table-list__head' role='row'>
                    <div className='columns small-4' role='columnheader'>
                        NAME
                    </div>
                    {showType && (
                        <div className='columns small-2' role='columnheader'>
                            TYPE
                        </div>
                    )}
                    <div className={showType ? 'columns small-3' : 'columns small-5'} role='columnheader'>
                        KEYS
                    </div>
                    <div className='columns small-2' role='columnheader'>
                        CREATED
                    </div>
                    <div className='columns small-1' role='columnheader'>
                        IMMUTABLE
                    </div>
                </div>
                {resources.map(resource => (
                    <div className='row argo-table-list__row' role='row' key={resource.name}>
                        <div className='columns small-4' role='cell'>
                            <ClipboardText text={resource.name} />
                        </div>
                        {showType && (
                            <div className='columns small-2' role='cell'>
                                {resource.type || '-'}
                            </div>
                        )}
                        <div className={showType ? 'columns small-3' : 'columns small-5'} role='cell'>
                            {!resource.keys ? (
                                <button className='argo-button argo-button--neutral' onClick={() => onDetails(resource)} aria-label={`Show keys for ${resource.name}`}>
                                    Show keys
                                </button>
                            ) : resource.keys.length === 0 ? (
                                <span className='environment__muted'>no keys</span>
                            ) : (
                                resource.keys.map(key => (
                                    <span className='environment__key' key={key.name} title={`${key.size} bytes, value masked`}>
                                        {key.name}
                                    </span>
                                ))
                            )}
                        </div>
                        <div className='columns small-2' role='cell'>
                            {resource.createdAt ? <Timestamp date={resource.createdAt} compact={true} /> : '-'}
                        </div>
                        <div className='columns small-1' role='cell'>
                            {resource.keys ? (resource.immutable ? 'yes' : 'no') : '-'}
                        </div>
                    </div>
                ))}
                {resources.length === 0 && (
                    <div className='row argo-table-list__row' role='row'>
                        <div className='columns small-12' role='cell'>
                            {emptyMessage}
                        </div>
                    </div>
                )}
            </div>
            {more && (
                <button className='argo-button argo-button--neutral' onClick={more}>
                    Load more {title}
                </button>
            )}
        </section>
    );
}
