import classNames from 'classnames';
import * as React from 'react';
import {ReactNode} from 'react';

import './zero-state.scss';

// https://designsystem.quickbooks.com/pattern/zero-states/
export const ZeroState = (props: {title?: string; children: ReactNode; className?: string}) => (
    <div className={classNames('white-box', 'zero-state', props.className)}>
        <h4>{props.title || 'Nothing to show'}</h4>
        {props.children}
    </div>
);
