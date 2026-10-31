import {NavigationManager} from 'argo-ui/src/components/navigation';
import {NotificationsManager} from 'argo-ui/src/components/notifications/notification-manager';
import {PageContext} from 'argo-ui/src/components/page/page';
import {PopupManager} from 'argo-ui/src/components/popup/popup-manager';
import type {History} from 'history';
import * as React from 'react';

import 'argo-ui/src/styles/main.scss';

import {AppRouter} from './app-router';
import {ContextApis, Provider} from './shared/context';

export function App({history}: {history: History}) {
    const popupManager: PopupManager = new PopupManager();
    const notificationsManager: NotificationsManager = new NotificationsManager();
    const navigationManager: NavigationManager = new NavigationManager(history);

    const providerContext: ContextApis = {
        notifications: notificationsManager,
        popup: popupManager,
        navigation: navigationManager,
        history
    };

    return (
        <Provider value={providerContext}>
            <PageContext.Provider value={{title: 'workflows'}}>
                <AppRouter history={history} notificationsManager={notificationsManager} popupManager={popupManager} />
            </PageContext.Provider>
        </Provider>
    );
}
