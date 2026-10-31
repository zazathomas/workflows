import {Ticker} from 'argo-ui/src/components/ticker';
import * as React from 'react';

import {ago} from '../duration';
import useTimestamp, {TIMESTAMP_KEYS} from '../use-timestamp';
import {Tooltip} from './tooltip';

import './timestamp.scss';

interface Props {
    date: Date | string | number;
    timestampKey?: TIMESTAMP_KEYS;
    displayLocalDateTime?: boolean;
    displayISOFormat?: boolean;
    compact?: boolean;
}

export function Timestamp({date, timestampKey, displayLocalDateTime, displayISOFormat, compact}: Props) {
    const [storedDisplayISOFormat, setStoredDisplayISOFormat] = useTimestamp(timestampKey);

    const displayISOFormatValue = displayISOFormat ?? storedDisplayISOFormat;

    if (date === null || date === undefined) return <span>-</span>;

    return (
        <span>
            <span title={date.toString()}>
                {displayISOFormatValue ? (
                    new Date(date.toString()).toISOString()
                ) : (
                    <>
                        {displayLocalDateTime ? (
                            <>
                                {new Date(date.toString()).toLocaleString()} (<Ticker intervalMs={1000}>{() => ago(new Date(date))}</Ticker>)
                            </>
                        ) : (
                            <Ticker intervalMs={1000}>{() => (compact ? ago(new Date(date)).replace(/ ago$/, '') : ago(new Date(date)))}</Ticker>
                        )}
                    </>
                )}
            </span>
            {timestampKey ? <TimestampSwitch storedDisplayISOFormat={storedDisplayISOFormat} setStoredDisplayISOFormat={setStoredDisplayISOFormat} /> : null}
        </span>
    );
}

export function TimestampSwitch({storedDisplayISOFormat, setStoredDisplayISOFormat}: {storedDisplayISOFormat: boolean; setStoredDisplayISOFormat: (value: boolean) => void}) {
    return (
        <Tooltip content={storedDisplayISOFormat ? 'Switch to relative time format' : 'Switch to ISO time format'}>
            <button
                type='button'
                className='timestamp-switch'
                aria-label={storedDisplayISOFormat ? 'Show relative time' : 'Show ISO time'}
                aria-pressed={storedDisplayISOFormat}
                onClick={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    setStoredDisplayISOFormat(!storedDisplayISOFormat);
                }}>
                <i className='fa fa-clock' aria-hidden='true' />
            </button>
        </Tooltip>
    );
}
