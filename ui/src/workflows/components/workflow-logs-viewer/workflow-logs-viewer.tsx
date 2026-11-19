import {Autocomplete} from 'argo-ui/src/components/autocomplete/autocomplete';
import * as React from 'react';
import {useContext, useEffect, useRef, useState} from 'react';
import {Observable} from 'rxjs';
import {filter, map, publishReplay, refCount, tap} from 'rxjs/operators';

import {Button} from '../../../shared/components/button';
import {ErrorNotice} from '../../../shared/components/error-notice';
import {InfoIcon, WarningIcon} from '../../../shared/components/fa-icons';
import {Links} from '../../../shared/components/links';
import {Context} from '../../../shared/context';
import debounce from '../../../shared/debounce';
import * as models from '../../../shared/models';
import {execSpec} from '../../../shared/models';
import {getPodName, getTemplateNameFromNode} from '../../../shared/pod-name';
import {ScopedLocalStorage} from '../../../shared/scoped-local-storage';
import {services} from '../../../shared/services';
import {useLocalStorage} from '../../../shared/use-local-storage';
import {isArgoRuntimeLog} from './argo-runtime-log';
import {FullHeightLogsViewer} from './full-height-logs-viewer';
import {extractJsonValue, JsonLogsFieldSelector, SelectedJsonFields} from './json-logs-field-selector';
import {colorizeLogLine, detectLogLevel, highlightMatches, MinimumLevel, passesLevelFilter} from './log-colorizer';

const TZ_LOCALSTORAGE_KEY = 'DEFAULT_TZ';
const VERBOSE_LOGS_LOCALSTORAGE_KEY = 'SHOW_VERBOSE_POD_LOGS';
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'UTC';
const timezones = Intl.supportedValuesOf('timeZone');
// the plain (unstyled) lines kept for copy/download; the terminal keeps its
// own scrollback, this only bounds the extra copy
const MAX_PLAIN_LOG_LINES = 100000;
const COPY_FEEDBACK_MS = 1500;

interface WorkflowLogsViewerProps {
    workflow: models.Workflow;
    initialNodeId?: string;
    initialPodName: string;
    container: string;
    archived: boolean;
}

function identity<T>(value: T) {
    return () => value;
}

// USED FOR MANUAL TESTING
// const timeSpammer:Observable<string> = new Observable((subscriber) => {
//   setInterval(() => {
//     subscriber.next('time="2022-11-27T04:07:37.291Z" level=info msg="running spammer" argo=true\n');
//   }, 2000);
// });

interface ParsedTime {
    quoted: string;
    fullstring: string;
}
// extract the time field from a string
function parseTime(formattedString: string): undefined | ParsedTime {
    const re = new RegExp('time="(.*?)"');
    const table = re.exec(formattedString);
    if (table === null || table.length !== 2) {
        return undefined;
    }
    return {quoted: table[1], fullstring: table[0]};
}

function parseAndTransform(formattedString: string, timeZone: string) {
    const maybeTime = parseTime(formattedString);
    if (maybeTime === undefined) {
        return formattedString;
    }

    try {
        // hack to get a local ISO time: en-CA locale is very close to ISO (https://en.wikipedia.org/wiki/Date_and_time_notation_in_Canada)
        const newTime = new Date(maybeTime.quoted).toLocaleString('en-CA', {timeZone, hour12: false}).replace(', ', 'T');
        const shortTz = new Date().toLocaleTimeString('en-US', {timeZone, timeZoneName: 'short'}).split(' ')[2];
        const newFormattedTime = `time="${newTime} ${shortTz}"`;
        const newFormattedString = formattedString.replace(maybeTime.fullstring, newFormattedTime);
        return newFormattedString;
    } catch {
        return formattedString;
    }
}

export function WorkflowLogsViewer({workflow, initialNodeId, initialPodName, container, archived}: WorkflowLogsViewerProps) {
    const storage = new ScopedLocalStorage('workflow-logs-viewer');

    const {popup} = useContext(Context);
    const [podName, setPodName] = useState(initialPodName || '');
    const [selectedContainer, setContainer] = useState(container);
    const [grep, setGrep] = useState('');
    const [error, setError] = useState<Error>();
    const [loaded, setLoaded] = useState(false);
    const [logSource, setLogSource] = useState<{key: string; observable: Observable<string>}>();
    // minimum severity shown in the console; deliberately not persisted, so the
    // console always opens showing everything the container printed
    const [levelFilter, setLevelFilter] = useState<MinimumLevel>('all');
    const [copied, setCopied] = useState(false);
    // the plain (unstyled) lines of the current stream, kept for copy/download
    const plainLogLines = useRef<string[]>([]);
    const [showVerbosePodLogs, setShowVerbosePodLogs] = useState(() => {
        try {
            return window.localStorage.getItem(VERBOSE_LOGS_LOCALSTORAGE_KEY) === 'true';
        } catch {
            return false;
        }
    });

    function toggleVerbosePodLogs(checked: boolean) {
        setShowVerbosePodLogs(checked);
        try {
            window.localStorage.setItem(VERBOSE_LOGS_LOCALSTORAGE_KEY, String(checked));
        } catch {
            // The checkbox still works for this view if browser storage is blocked.
        }
    }
    const [selectedJsonFields, setSelectedJsonFields] = useState<SelectedJsonFields>(() => {
        return storage.getItem<SelectedJsonFields>('jsonFields', {values: []});
    });
    const [templateFromRef, setTemplateFromRef] = useState<models.Template>(null);

    function setDebouncedGrep(value: string) {
        debounce(() => setGrep(value), 1000)[0]();
    }

    // timezone used for ui rendering only
    const [uiTimezone, setUITimezone] = useState<string>(DEFAULT_TZ);
    // timezone used for timezone formatting
    const [timezone, setTimezone] = useLocalStorage<string>(TZ_LOCALSTORAGE_KEY, DEFAULT_TZ);
    // update the UI every time the timezone changes
    useEffect(() => {
        setUITimezone(timezone);
    }, [timezone]);

    // Map pod names to node IDs before creating the log stream; the selected
    // node can change as a newly submitted Run reports its pods.
    const podNamesToNodeIDs = new Map<string, string>();
    const podNames = [{value: '', label: 'All'}].concat(
        Object.values(workflow.status.nodes || {})
            .filter(x => x.type === 'Pod')
            .map(targetNode => {
                const {name, id, displayName} = targetNode;
                const targetPodName = getPodName(workflow, targetNode);
                podNamesToNodeIDs.set(targetPodName, id);
                return {value: targetPodName, label: (displayName || name) + ' (' + targetPodName + ')'};
            })
    );
    const nodeId = initialNodeId || podNamesToNodeIDs.get(podName);
    const node = workflow.status.nodes?.[nodeId];

    useEffect(() => {
        setError(null);
        setLoaded(false);
        plainLogLines.current = [];
        const source = services.workflows.getContainerLogs(workflow, podName, nodeId, selectedContainer, grep, archived).pipe(
            tap(() => setLoaded(true)),
            filter(e => showVerbosePodLogs || !isArgoRuntimeLog(e.content || '')),
            filter(e => passesLevelFilter(detectLogLevel(e.content), levelFilter)),
            // extract message from LogEntry
            map(e => {
                const values: string[] = [];
                const content = e.content;
                if (selectedJsonFields.values.length > 0) {
                    try {
                        const json = JSON.parse(content);
                        selectedJsonFields.values.forEach(selectedJsonField => {
                            const value = extractJsonValue(json, selectedJsonField);
                            if (value) {
                                values.push(value);
                            }
                        });
                    } catch (e) {
                        // if not json, show content directly
                    }
                }
                if (values.length === 0) {
                    values.push(content);
                }
                return `${!podName ? e.podName + ': ' : ''}${values.join(' ')}\n`;
            }),
            tap(line => {
                plainLogLines.current.push(line);
                if (plainLogLines.current.length > MAX_PLAIN_LOG_LINES) {
                    plainLogLines.current.shift();
                }
            }),
            map((x: string) => parseAndTransform(x, timezone)),
            // style the line for the console (timestamps, severity, pod prefix) and
            // highlight the search term in bold on yellow — without matching the
            // styling escapes. The visible text is unchanged. (One operator, to
            // stay within rxjs' nine typed pipe() overloads.)
            map(x => highlightMatches(colorizeLogLine(x, {podPrefix: !podName}), grep)),
            publishReplay(),
            refCount()
        );

        // const source = timeSpammer.pipe(
        //   map((x)=> parseAndTransform(x, timezone)),
        //   publishReplay(),
        //   refCount()
        // );
        const subscription = source.subscribe(
            () => setLoaded(true),
            setError,
            () => setLoaded(true)
        );
        setLogSource({
            key: JSON.stringify([
                workflow.metadata.uid || workflow.metadata.name,
                podName,
                nodeId,
                selectedContainer,
                grep,
                archived,
                selectedJsonFields.values,
                timezone,
                showVerbosePodLogs,
                levelFilter
            ]),
            observable: source
        });
        return () => subscription.unsubscribe();
    }, [workflow.metadata.namespace, workflow.metadata.name, podName, nodeId, selectedContainer, grep, archived, selectedJsonFields, timezone, showVerbosePodLogs, levelFilter]);

    useEffect(() => {
        if (!node || !node.templateRef) {
            setTemplateFromRef(null);
            return;
        }

        const fetchTemplate = async () => {
            try {
                const tmpl = node.templateRef.clusterScope
                    ? await services.clusterWorkflowTemplate.get(node.templateRef.name)
                    : await services.workflowTemplate.get(node.templateRef.name, workflow.metadata.namespace);
                const matchingTemplate = tmpl.spec.templates.find(t => t.name === node.templateRef.template);

                if (matchingTemplate) {
                    setTemplateFromRef(matchingTemplate);
                } else {
                    setTemplateFromRef(null);
                }
            } catch (err) {
                setTemplateFromRef(null);
            }
        };

        fetchTemplate();
    }, [node, workflow.metadata.namespace]);

    let templates = (execSpec(workflow).templates || []).filter(t => !node || t.name === getTemplateNameFromNode(node));

    if (templates.length === 0 && node && node.templateRef && templateFromRef) {
        templates = [templateFromRef];
    }

    const containers = [
        ...new Set(
            ['init', 'wait', `supervisor`].concat(
                templates
                    .map(t => ((t.containerSet && t.containerSet.containers) || [{name: 'main'}]).concat(t.sidecars || []).concat(t.initContainers || []))
                    .reduce((a, v) => a.concat(v), [])
                    .map(c => c.name)
            )
        )
    ];
    const [candidateContainer, setCandidateContainer] = useState(container);
    const filteredTimezones = timezones.filter(tz => tz.startsWith(uiTimezone) || uiTimezone === '');

    async function popupJsonFieldSelector() {
        const fields = {...selectedJsonFields};
        const updated = await popup.confirm('Select Json Fields', () => (
            <JsonLogsFieldSelector
                fields={selectedJsonFields}
                onChange={values => {
                    fields.values = values;
                }}
            />
        ));
        if (updated) {
            storage.setItem('jsonFields', fields, {values: []});
            setSelectedJsonFields(fields);
        }
    }

    async function copyLogs() {
        const text = plainLogLines.current.join('');
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // non-secure contexts (plain http off localhost) have no clipboard
                // API; fall back to the legacy copy so the button still works
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        } catch (err) {
            setError(new Error('Could not copy the logs: ' + (err as Error).message));
        }
    }

    function downloadLogs() {
        const blob = new Blob([plainLogLines.current.join('')], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${workflow.metadata.name}-${podName || 'all-pods'}-${selectedContainer}.log`;
        link.click();
        URL.revokeObjectURL(url);
    }

    // Semaphore-style raw log: the unprocessed lines in a plain-text tab. For a
    // running pod this is a snapshot of what has streamed so far.
    function openRawLogs() {
        const blob = new Blob([plainLogLines.current.join('')], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    return (
        <div className='workflow-logs-viewer'>
            <h3>Logs</h3>
            {archived && (
                <p>
                    <i className='fa fa-exclamation-triangle' /> Logs for archived workflows may be overwritten by a more recent workflow with the same name.
                </p>
            )}
            <div className='workflow-logs-viewer__toolbar' aria-label='Logs controls'>
                <div className='workflow-logs-viewer__toolbar-row'>
                    <i className='fa fa-box' aria-hidden='true' />{' '}
                    <Autocomplete
                        items={podNames}
                        value={(podNames.find(x => x.value === podName) || {label: ''}).label}
                        onSelect={(_, item) => {
                            setPodName(item.value);
                        }}
                    />{' '}
                    /{' '}
                    <Autocomplete
                        items={containers}
                        value={candidateContainer}
                        onSelect={v => {
                            setCandidateContainer(v);
                            setContainer(v);
                        }}
                        onChange={v => setCandidateContainer(v.target.value)}
                        renderInput={props => (
                            <input
                                {...props}
                                onKeyUp={event => {
                                    if (event.keyCode === 13) {
                                        // ENTER, to confirm custom container name input
                                        setContainer(candidateContainer);
                                    }
                                }}
                            />
                        )}
                    />
                    <Button onClick={popupJsonFieldSelector} icon={'exchange-alt'} title={'Choose which JSON fields to display'}>
                        Log Fields
                    </Button>
                    <label className='workflow-logs-viewer__verbose-toggle'>
                        <input type='checkbox' checked={showVerbosePodLogs} onChange={event => toggleVerbosePodLogs(event.target.checked)} /> Show verbose pod logs
                    </label>
                </div>
                <div className='workflow-logs-viewer__toolbar-row workflow-logs-viewer__console-controls'>
                    <label className='workflow-logs-viewer__level-filter'>
                        Level{' '}
                        <select value={levelFilter} onChange={event => setLevelFilter(event.target.value as MinimumLevel)} aria-label='Minimum log level'>
                            <option value='all'>All</option>
                            <option value='info'>Info &amp; above</option>
                            <option value='warn'>Warnings &amp; above</option>
                            <option value='error'>Errors &amp; above</option>
                        </select>
                    </label>
                    <span className='workflow-logs-viewer__filter'>
                        <i className='fa fa-filter' aria-hidden='true' />{' '}
                        <input
                            type='search'
                            defaultValue={grep}
                            onChange={v => setDebouncedGrep(v.target.value)}
                            placeholder='Filter (regexp)...'
                            aria-label='Filter logs (regular expression)'
                        />
                    </span>
                    <span className='workflow-logs-viewer__timezone'>
                        <i className='fa fa-globe' aria-hidden='true' />{' '}
                        <Autocomplete
                            items={filteredTimezones}
                            value={uiTimezone}
                            onChange={v => setUITimezone(v.target.value)}
                            // useEffect ensures UITimezone is also changed
                            onSelect={setTimezone}
                        />
                    </span>
                    <span className='workflow-logs-viewer__spacer' />
                    <Button outline onClick={copyLogs} icon={'copy'} title={'Copy the logs to the clipboard'}>
                        {copied ? 'Copied!' : 'Copy'}
                    </Button>
                    <Button outline onClick={downloadLogs} icon={'download'} title={'Download the logs as a file'}>
                        Download
                    </Button>
                    <Button outline onClick={openRawLogs} icon={'external-link-alt'} title={'Open the unprocessed log output in a new tab'}>
                        Raw
                    </Button>
                </div>
            </div>
            <ErrorNotice error={error} />
            {!loaded || !logSource ? (
                <p className='white-box'>
                    <i className='fa fa-circle-notch fa-spin' /> Waiting for data...
                </p>
            ) : (
                <FullHeightLogsViewer
                    source={{
                        key: logSource.key,
                        loadLogs: identity(logSource.observable),
                        shouldRepeat: () => false
                    }}
                />
            )}
            <p>
                {selectedContainer === 'init' && (
                    <>
                        <InfoIcon /> Init containers logs are useful when debugging input artifact problems.
                    </>
                )}
                {selectedContainer === 'wait' && (
                    <>
                        {' '}
                        <InfoIcon /> Wait containers logs are useful when debugging output artifact problems.
                    </>
                )}
                {podName && podNamesToNodeIDs.get(podName) && (
                    <>
                        Still waiting for data or an error? Try getting{' '}
                        <a href={services.workflows.getArtifactLogsPath(workflow, podNamesToNodeIDs.get(podName), selectedContainer, archived)} target='_blank' rel='noreferrer'>
                            logs from the artifacts
                        </a>
                        .
                    </>
                )}
                {execSpec(workflow).podGC && (
                    <>
                        <WarningIcon /> Your pod GC settings will delete pods{' '}
                        {execSpec(workflow).podGC.deleteDelayDuration ? `after ${execSpec(workflow).podGC.deleteDelayDuration}` : 'immediately'} on completion.
                    </>
                )}{' '}
                Logs may not appear for pods that are deleted unless you have{' '}
                <a href='https://argo-workflows.readthedocs.io/en/latest/configure-archive-logs' target='_blank' rel='noreferrer'>
                    archive logs
                </a>{' '}
                enabled.{' '}
                {podName ? (
                    <Links
                        object={{
                            metadata: {
                                namespace: workflow.metadata.namespace,
                                name: podName
                            },
                            workflow,
                            status: {
                                startedAt: workflow.status.startedAt,
                                finishedAt: workflow.status.finishedAt
                            }
                        }}
                        scope='pod-logs'
                    />
                ) : (
                    <Links object={workflow} scope='workflow' />
                )}
            </p>
        </div>
    );
}
