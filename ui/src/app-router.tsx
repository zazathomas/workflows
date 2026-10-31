import {NotificationsManager} from 'argo-ui/src/components/notifications/notification-manager';
import {Notifications, NotificationType} from 'argo-ui/src/components/notifications/notifications';
import {Popup, PopupProps} from 'argo-ui/src/components/popup/popup';
import {PopupManager} from 'argo-ui/src/components/popup/popup-manager';
import * as H from 'history';
import * as React from 'react';
import {useEffect, useState} from 'react';
import {Redirect, Route, Router, Switch} from 'react-router';

import apiDocs from './api-docs';
import clusterWorkflowTemplates from './cluster-workflow-templates';
import cronWorkflows from './cron-workflows';
import eventflow from './event-flow';
import eventSources from './event-sources';
import help from './help';
import login from './login';
import {ModalSwitch} from './modals/modal-switch';
import plugins from './plugins';
import reports from './reports';
import {RunActionProvider} from './run-actions/run-action-provider';
import sensors from './sensors';
import {uiUrl} from './shared/base';
import {ChatButton} from './shared/components/chat-button';
import ErrorBoundary from './shared/components/error-boundary';
import {ModernLayout} from './shared/components/modern-layout';
import {Version} from './shared/models';
import * as nsUtils from './shared/namespaces';
import {services} from './shared/services';
import userinfo from './userinfo';
import {Widgets} from './widgets/widgets';
import workflowEventBindings from './workflow-event-bindings';
import workflowTemplates from './workflow-templates';
import workflows from './workflows';

const eventFlowUrl = uiUrl('event-flow');
const sensorUrl = uiUrl('sensors');
const workflowsUrl = uiUrl('workflows');
const workflowsEventBindingsUrl = uiUrl('workflow-event-bindings');
const workflowTemplatesUrl = uiUrl('workflow-templates');
const clusterWorkflowTemplatesUrl = uiUrl('cluster-workflow-templates');
const cronWorkflowsUrl = uiUrl('cron-workflows');
const eventSourceUrl = uiUrl('event-sources');
const pluginsUrl = uiUrl('plugins');
const helpUrl = uiUrl('help');
const apiDocsUrl = uiUrl('apidocs');
const userInfoUrl = uiUrl('userinfo');
const loginUrl = uiUrl('login');
const timelineUrl = uiUrl('timeline');
const reportsUrl = uiUrl('reports');

export function AppRouter({popupManager, history, notificationsManager}: {popupManager: PopupManager; history: H.History; notificationsManager: NotificationsManager}) {
    const [popupProps, setPopupProps] = useState<PopupProps>();
    const [modals, setModals] = useState<{string: boolean}>();
    const [version, setVersion] = useState<Version>();
    const [namespace, setNamespace] = useState<string>();
    const [userName, setUserName] = useState<string>();
    const [actionSubject, setActionSubject] = useState<string>();
    const [navBarBackgroundColor, setNavBarBackgroundColor] = useState<string>();
    const setError = (error: Error) => {
        notificationsManager.show({
            content: 'Failed to load version/info ' + error,
            type: NotificationType.Error
        });
    };
    nsUtils.setOnNamespaceChange(setNamespace);
    useEffect(() => {
        const sub = popupManager.popupProps.subscribe(setPopupProps);
        return () => sub.unsubscribe();
    }, [popupManager]);
    useEffect(() => {
        services.info
            .getUserInfo()
            .then(userInfo => {
                nsUtils.setUserNamespace(userInfo.serviceAccountNamespace);
                setNamespace(nsUtils.getCurrentNamespace());
                setUserName(userInfo.subject);
                // Client and server auth modes do not return OIDC claims. Scope
                // those monitors to this browser tab; the login route clears them.
                setActionSubject(userInfo.subject ? `${userInfo.issuer || 'sso'}:${userInfo.subject}` : 'browser-session');
            })
            .catch(setError);
        services.info
            .getInfo()
            .then(info => {
                nsUtils.setManagedNamespace(info.managedNamespace);
                setNamespace(nsUtils.getCurrentNamespace());
                setModals(info.modals);
                setNavBarBackgroundColor(info.navColor);
            })
            .then(() => services.info.getVersion())
            .then(setVersion)
            .catch(setError);
    }, []);

    const managedNamespace = nsUtils.getManagedNamespace();
    const namespaceSuffix = managedNamespace ? '' : '/' + (namespace || '');
    return (
        <RunActionProvider key={actionSubject || 'loading'} subject={actionSubject} history={history}>
            {popupProps && <Popup {...popupProps} />}
            <Router history={history}>
                <Switch>
                    <Route exact={true} strict={true} path={loginUrl} component={login.component} />
                    <Route path={uiUrl('widgets')} component={Widgets} />
                    <ModernLayout
                        history={history}
                        navBarStyle={{backgroundColor: navBarBackgroundColor}}
                        userName={userName}
                        navItems={[
                            {
                                title: 'Jobs',
                                path: workflowTemplatesUrl + namespaceSuffix,
                                activePaths: [clusterWorkflowTemplatesUrl],
                                iconClassName: 'fa fa-window-maximize',
                                group: 'Self service'
                            },
                            {
                                title: 'Runs',
                                path: workflowsUrl + namespaceSuffix,
                                iconClassName: 'fa fa-stream',
                                group: 'Self service'
                            },
                            {
                                title: 'Schedules',
                                path: cronWorkflowsUrl + namespaceSuffix,
                                iconClassName: 'fa fa-clock',
                                group: 'Self service'
                            },
                            {
                                title: 'Event Flow',
                                path: eventFlowUrl + namespaceSuffix,
                                iconClassName: 'fa fa-broadcast-tower',
                                group: 'Events'
                            },
                            {
                                title: 'Event Sources',
                                path: eventSourceUrl + namespaceSuffix,
                                iconClassName: 'fas fa-bolt',
                                group: 'Events'
                            },
                            {
                                title: 'Sensors',
                                path: sensorUrl + namespaceSuffix,
                                iconClassName: 'fa fa-satellite-dish',
                                group: 'Events'
                            },
                            {
                                title: 'Workflow Event Bindings',
                                path: workflowsEventBindingsUrl + namespaceSuffix,
                                iconClassName: 'fa fa-link',
                                group: 'Events'
                            },
                            {
                                title: 'Reports',
                                path: reportsUrl + namespaceSuffix,
                                iconClassName: 'fa fa-chart-bar',
                                group: 'Insights'
                            },
                            {
                                title: 'User Info',
                                path: userInfoUrl,
                                iconClassName: 'fa fa-user-alt',
                                group: 'Administration'
                            },
                            {
                                title: 'API Docs',
                                path: apiDocsUrl,
                                iconClassName: 'fa fa-code',
                                group: 'Administration'
                            },
                            {
                                title: 'Plugins',
                                path: pluginsUrl,
                                iconClassName: 'fa fa-puzzle-piece',
                                group: 'Administration'
                            },
                            {
                                title: 'Help',
                                path: helpUrl,
                                iconClassName: 'fa fa-question-circle',
                                group: 'Administration'
                            }
                        ]}
                        version={() => (version ? <>{version.version}</> : null)}>
                        <Notifications notifications={notificationsManager.notifications} />
                        <ErrorBoundary>
                            <Switch>
                                <Route exact={true} strict={true} path={timelineUrl}>
                                    <Redirect to={workflowsUrl} />
                                </Route>
                                <Route path={eventFlowUrl} component={eventflow.component} />
                                <Route path={sensorUrl} component={sensors.component} />
                                <Route path={eventSourceUrl} component={eventSources.component} />
                                <Route path={workflowsUrl} component={workflows.component} />
                                <Route path={workflowsEventBindingsUrl} component={workflowEventBindings.component} />
                                <Route path={workflowTemplatesUrl} component={workflowTemplates.component} />
                                <Route path={clusterWorkflowTemplatesUrl} component={clusterWorkflowTemplates.component} />
                                <Route path={cronWorkflowsUrl} component={cronWorkflows.component} />
                                <Route path={reportsUrl} component={reports.component} />
                                <Route path={pluginsUrl} component={plugins.component} />
                                <Route exact={true} strict={true} path={helpUrl} component={help.component} />
                                <Route exact={true} strict={true} path={apiDocsUrl} component={apiDocs.component} />
                                <Route exact={true} strict={true} path={userInfoUrl} component={userinfo.component} />
                                {managedNamespace && <Redirect to={workflowTemplatesUrl} />}
                                {namespace && <Redirect to={workflowTemplatesUrl + '/' + namespace} />}
                            </Switch>
                        </ErrorBoundary>
                        <ChatButton />
                        {version && modals && <ModalSwitch version={version.version} modals={modals} />}
                    </ModernLayout>
                </Switch>
            </Router>
        </RunActionProvider>
    );
}
