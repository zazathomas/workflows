import * as React from 'react';
import {useEffect, useRef, useState} from 'react';

import {Parameter} from '../models';
import {ParameterSource, ParameterSources} from '../parameter-sources';
import {services} from '../services';
import {ParameterDescription} from './parameter-description';
import {getValueFromParameter} from './parameters-input';

import './dynamic-parameters-input.scss';

interface Props {
    parameters: Parameter[];
    sources: ParameterSources;
    namespace: string;
    templateKind: 'WorkflowTemplate' | 'ClusterWorkflowTemplate';
    templateName: string;
    onChange: (parameters: Parameter[]) => void;
}

interface Option {
    label: string;
    value: string;
}

interface CachedOptions {
    key: string;
    options?: Option[];
    error?: string;
}

function getSourceDependencyNames(source: ParameterSource): string[] {
    const dependencies = new Set(source.dependsOn || []);
    const interpolationPattern = /\{\{\s*([\w.-]+)\s*\}\}|\$\{\s*([\w.-]+)\s*\}/g;
    let match: RegExpExecArray | null;
    while (source.url && (match = interpolationPattern.exec(source.url))) {
        dependencies.add(match[1] || match[2]);
    }
    return Array.from(dependencies).sort();
}

function getSourceRequestKey(source: ParameterSource, values: Record<string, string>, namespace: string, templateKind: string, templateName: string, refreshKey: number) {
    const dependencyValues = getSourceDependencyNames(source).map(name => [name, values[name] || '']);
    return JSON.stringify({source, namespace, templateKind, templateName, dependencyValues, refreshKey});
}

function isRequired(parameter: Parameter): boolean {
    return parameter.default === undefined && parameter.value === undefined;
}

export function DynamicParametersInput(props: Props) {
    const [options, setOptions] = useState<Record<string, Option[]>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState<Record<string, boolean>>({});
    const [refreshKeys, setRefreshKeys] = useState<Record<string, number>>({});
    const [announcement, setAnnouncement] = useState('');
    const cache = useRef<Record<string, CachedOptions>>({});
    const inFlight = useRef<Record<string, {key: string; controller: AbortController; promise: Promise<Option[]>}>>({});
    const previousKeys = useRef<Record<string, string>>({});

    useEffect(() => () => Object.values(inFlight.current).forEach(entry => entry.controller.abort()), []);
    const parameterValuesKey = JSON.stringify(props.parameters.map(parameter => [parameter.name, getValueFromParameter(parameter) || '']));

    useEffect(() => {
        let cancelled = false;
        const values = props.parameters.reduce<Record<string, string>>((result, parameter) => {
            result[parameter.name] = getValueFromParameter(parameter) || '';
            return result;
        }, {});
        const sourceEntries = Object.entries(props.sources);
        for (const name of Object.keys(inFlight.current)) {
            if (!(name in props.sources)) {
                inFlight.current[name].controller.abort();
                delete inFlight.current[name];
            }
        }
        const nextOptions: Record<string, Option[]> = {};
        const nextErrors: Record<string, string> = {};
        const loadingNames: Record<string, boolean> = {};
        const requests: Array<Promise<{name: string; sourceOptions?: Option[]; error?: string; key: string}>> = [];

        sourceEntries.forEach(([name, source]) => {
            const key = getSourceRequestKey(source, values, props.namespace, props.templateKind, props.templateName, refreshKeys[name] || 0);
            const missingDependency = getSourceDependencyNames(source).some(dependency => !values[dependency]);
            const cached = cache.current[name];

            const previous = previousKeys.current[name];
            previousKeys.current[name] = key;
            if (missingDependency) {
                inFlight.current[name]?.controller.abort();
                delete inFlight.current[name];
                nextOptions[name] = [];
                return;
            }
            if (cached?.key === key) {
                if (cached.options) {
                    nextOptions[name] = cached.options;
                }
                if (cached.error) {
                    nextErrors[name] = cached.error;
                }
                return;
            }

            loadingNames[name] = true;
            let entry = inFlight.current[name];
            if (entry && entry.key !== key) {
                entry.controller.abort();
                entry = undefined;
            }
            if (!entry) {
                const controller = new AbortController();
                const load = () => services.parameterOptions.get(source, values, props.namespace, props.templateKind, props.templateName, name, controller.signal);
                const promise =
                    previous && previous !== key && getSourceDependencyNames(source).length > 0
                        ? new Promise<Option[]>((resolve, reject) => {
                              const timer = setTimeout(() => load().then(resolve, reject), 300);
                              controller.signal.addEventListener(
                                  'abort',
                                  () => {
                                      clearTimeout(timer);
                                      reject(new Error('Request superseded'));
                                  },
                                  {once: true}
                              );
                          })
                        : load();
                entry = {key, controller, promise};
                inFlight.current[name] = entry;
                promise
                    .finally(() => {
                        if (inFlight.current[name] === entry) delete inFlight.current[name];
                    })
                    .catch(() => undefined);
            }
            requests.push(
                entry.promise
                    .then(sourceOptions => ({name, sourceOptions, key}))
                    .catch(error => ({name, error: error instanceof Error ? error.message : 'Failed to load options', key}))
            );
        });

        setOptions(nextOptions);
        setErrors(nextErrors);
        setLoading(loadingNames);

        Promise.all(requests).then(results => {
            if (cancelled) {
                return;
            }
            const resolvedOptions = {...nextOptions};
            const resolvedErrors = {...nextErrors};
            const resolvedLoading = {...loadingNames};
            results.forEach(result => {
                cache.current[result.name] = {
                    key: result.key,
                    options: result.sourceOptions,
                    error: result.error
                };
                if (result.error) {
                    resolvedErrors[result.name] = result.error;
                    delete resolvedOptions[result.name];
                } else {
                    resolvedOptions[result.name] = result.sourceOptions || [];
                    delete resolvedErrors[result.name];
                }
                delete resolvedLoading[result.name];
            });
            setOptions(resolvedOptions);
            setErrors(resolvedErrors);
            setLoading(resolvedLoading);
        });

        return () => {
            cancelled = true;
        };
    }, [parameterValuesKey, props.namespace, props.templateKind, props.templateName, props.sources, refreshKeys]);

    function onParameterChange(parameter: Parameter, value: string) {
        const cleared = new Set([parameter.name]);
        let changed = true;
        while (changed) {
            changed = false;
            Object.entries(props.sources).forEach(([name, source]) => {
                if (!cleared.has(name) && getSourceDependencyNames(source).some(dependency => cleared.has(dependency))) {
                    cleared.add(name);
                    changed = true;
                }
            });
        }

        const clearedDependents = Array.from(cleared).filter(name => name !== parameter.name);
        if (clearedDependents.length > 0) {
            setAnnouncement(`Cleared dependent values: ${clearedDependents.join(', ')}`);
        }

        props.onChange(
            props.parameters.map(current => ({
                ...current,
                value: current.name === parameter.name ? value : cleared.has(current.name) ? '' : getValueFromParameter(current)
            }))
        );
    }

    return (
        <>
            <span role='status' className='modern-visually-hidden'>
                {announcement}
            </span>
            {props.parameters.map((parameter, index) => {
                const source = props.sources[parameter.name];
                const sourceOptions = options[parameter.name];
                const value = getValueFromParameter(parameter) || '';
                const inputId = `workflow-parameter-${parameter.name}-${index}`;
                const descriptionId = `${inputId}-description`;
                const errorId = `${inputId}-error`;
                const isLoading = !!loading[parameter.name];
                const required = isRequired(parameter);
                const hasSourceSelect = !!source && sourceOptions !== undefined && !errors[parameter.name];
                return (
                    <div key={parameter.name + '_' + index} style={{marginBottom: 14}}>
                        <div className='parameter-label'>
                            <label htmlFor={inputId}>
                                {parameter.name}
                                {required && <span> (required)</span>}
                            </label>
                            <ParameterDescription id={descriptionId} description={parameter.description} />
                        </div>
                        {hasSourceSelect ? (
                            <select
                                id={inputId}
                                className='argo-field'
                                value={value}
                                disabled={isLoading}
                                aria-busy={isLoading}
                                aria-required={required}
                                aria-describedby={[parameter.description ? descriptionId : null, errors[parameter.name] ? errorId : null].filter(Boolean).join(' ') || undefined}
                                onChange={event => onParameterChange(parameter, event.target.value)}>
                                <option value=''>{isLoading ? 'Loading options...' : 'Select a value...'}</option>
                                {sourceOptions.map(option => (
                                    <option key={`${option.value}/${option.label}`} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        ) : parameter.enum ? (
                            <select
                                id={inputId}
                                className='argo-field'
                                value={value}
                                aria-required={required}
                                aria-describedby={parameter.description ? descriptionId : undefined}
                                onChange={event => onParameterChange(parameter, event.target.value)}>
                                {parameter.enum.map(enumValue => (
                                    <option key={enumValue} value={enumValue}>
                                        {enumValue}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <textarea
                                id={inputId}
                                className='argo-field'
                                value={value}
                                aria-required={required}
                                aria-describedby={[parameter.description ? descriptionId : null, errors[parameter.name] ? errorId : null].filter(Boolean).join(' ') || undefined}
                                onChange={event => onParameterChange(parameter, event.target.value)}
                            />
                        )}
                        {source && (
                            <div style={{marginTop: 4}}>
                                {isLoading && (
                                    <small role='status' aria-live='polite'>
                                        Loading options...
                                    </small>
                                )}
                                {errors[parameter.name] && (
                                    <small id={errorId} role='alert' className='parameter-error'>
                                        {errors[parameter.name]} You can enter a value manually.
                                    </small>
                                )}
                                <button
                                    type='button'
                                    className='argo-button argo-button--secondary'
                                    disabled={isLoading}
                                    onClick={() => setRefreshKeys(current => ({...current, [parameter.name]: (current[parameter.name] || 0) + 1}))}>
                                    <i className='fa fa-sync-alt' aria-hidden='true' /> Refresh options
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}

export {getSourceDependencyNames};
