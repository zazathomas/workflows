import * as React from 'react';

import {Workflow} from './models';

export interface RunActionApi {
    track(workflow: Workflow): void;
}

export const RunActionContext = React.createContext<RunActionApi | null>(null);
