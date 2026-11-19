import * as React from 'react';
import {useEffect, useRef, useState} from 'react';
import MonacoEditor from 'react-monaco-editor';

import {uiUrl} from '../base';
import {useEditableObject} from '../use-editable-object';
import {Button} from './button';
import type {Lang} from './object-parser';
import {PhaseIcon} from './phase-icon';
import {SuspenseMonacoEditor} from './suspense-monaco-editor';

interface Props<T> {
    type?: string;
    value: T;
    lang: Lang;
    text: string;
    onLangChange: (lang: Lang) => void;
    onChange?: (value: string) => void;
}

// Object kinds whose spec carries a templates list where the insert-step
// palette applies.
const TEMPLATE_KINDS = new Set(['Workflow', 'WorkflowTemplate', 'ClusterWorkflowTemplate', 'CronWorkflow']);

// YAML snippets inserted at the cursor (indented as entries of the
// spec.templates list).
const STEP_SNIPPETS: {name: string; title: string; snippet: string}[] = [
    {
        name: 'container',
        title: 'Container step',
        snippet: `  - name: step-name
    container:
      image: alpine:3.19
      command: [sh, -c]
      args: ['echo hello from a container step']
`
    },
    {
        name: 'suspend',
        title: 'Suspend / approval step',
        snippet: `  - name: approval-step
    suspend:
      duration: '5m' # remove for a manual approval (resume from the UI)
`
    },
    {
        name: 'steps',
        title: 'Steps group',
        snippet: `  - name: main-steps
    steps:
      - - name: first
          template: step-name
`
    },
    {
        name: 'dag',
        title: 'DAG template',
        snippet: `  - name: main-dag
    dag:
      tasks:
        - name: a
          template: step-name
`
    }
];

export function ObjectEditor<T>({type, value, text, lang, onChange, onLangChange}: Props<T>) {
    const [error, setError] = useState<Error>();
    const editor = useRef<MonacoEditor>(null);

    useEffect(() => {
        if (!editor.current || text === editor.current.editor.getValue()) {
            return;
        }
        editor.current.editor.setValue(text);
    }, [editor, text]);

    useEffect(() => {
        if (!type || lang !== 'json') {
            return;
        }

        (async () => {
            const uri = uiUrl('assets/jsonschema/schema.json');
            try {
                const res = await fetch(uri);
                const swagger = await res.json();
                // lazy load this, otherwise all of monaco-editor gets imported into the main bundle
                const languages = (await import(/* webpackChunkName: "monaco-editor" */ 'monaco-editor/esm/vs/editor/editor.api')).languages;
                // adds auto-completion to JSON only
                languages.json.jsonDefaults.setDiagnosticsOptions({
                    validate: true,
                    schemas: [
                        {
                            uri,
                            fileMatch: ['*'],
                            schema: {
                                $id: 'http://workflows.argoproj.io/' + type + '.json',
                                $ref: '#/definitions/' + type,
                                $schema: 'http://json-schema.org/draft-07/schema',
                                definitions: swagger.definitions
                            }
                        }
                    ]
                });
            } catch (err) {
                setError(err);
            }
        })();
    }, [lang, type]);

    // this calculation is rough, it is probably hard to work for for every case, essentially it is:
    // some pixels above and below for buttons, plus a bit of a buffer/padding
    const height = Math.max(600, window.innerHeight * 0.9 - 250);

    function insertSnippet(snippet: string) {
        const monaco = editor.current?.editor;
        if (!monaco || !onChange) {
            return;
        }
        const position = monaco.getPosition();
        monaco.executeEdits('insert-step-palette', [
            {range: {startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column}, text: snippet}
        ]);
        monaco.focus();
    }

    const stepPalette = !!(type && TEMPLATE_KINDS.has(type) && lang === 'yaml' && onChange !== null);

    return (
        <>
            <div style={{paddingBottom: '1em'}}>
                <Button outline={true} onClick={() => onLangChange(lang === 'yaml' ? 'json' : 'yaml')}>
                    <span style={{fontWeight: lang === 'json' ? 'bold' : 'normal'}}>JSON</span>/<span style={{fontWeight: lang === 'yaml' ? 'bold' : 'normal'}}>YAML</span>
                </Button>

                {Object.keys(value).map(x => (
                    <Button
                        key={x}
                        icon='caret-right'
                        outline={true}
                        onClick={() => {
                            // Attempt to move the correct section of the document. Ideally, we'd have the line at the top of the
                            // editor, but Monaco editor does not have method for this (e.g. `revealLineAtTop`).

                            // find the line for the section in either YAML or JSON
                            const index = text.split('\n').findIndex(y => (lang === 'yaml' ? y.startsWith(x + ':') : y.includes('"' + x + '":')));

                            if (index >= 0) {
                                const lineNumber = index + 1;
                                editor.current.editor.revealLineInCenter(lineNumber);
                                editor.current.editor.setPosition({lineNumber, column: 0});
                                editor.current.editor.focus();
                            }
                        }}>
                        {x}
                    </Button>
                ))}
                {stepPalette && (
                    <span className='object-editor__step-palette' title='Insert a template entry at the cursor (place it inside the spec.templates list)'>
                        <i className='fa fa-plus' aria-hidden='true' /> Insert:
                        {STEP_SNIPPETS.map(step => (
                            <Button key={step.name} outline={true} onClick={() => insertSnippet(step.snippet)} icon='code'>
                                {step.title}
                            </Button>
                        ))}
                    </span>
                )}
            </div>
            <div>
                <SuspenseMonacoEditor
                    ref={editor}
                    key='editor'
                    defaultValue={text}
                    language={lang}
                    height={height + 'px'}
                    options={{
                        readOnly: onChange === null,
                        minimap: {enabled: false},
                        guides: {
                            indentation: false
                        },
                        scrollBeyondLastLine: true
                    }}
                    onChange={v => {
                        if (onChange) {
                            try {
                                onChange(v);
                                setError(null);
                            } catch (e) {
                                setError(e);
                            }
                        }
                    }}
                />
            </div>
            {error && (
                <div style={{paddingTop: '1em'}}>
                    <PhaseIcon value='Error' /> {error.message}
                </div>
            )}
            {onChange && (
                <div>
                    <i className='fa fa-info-circle' />{' '}
                    {lang === 'json' ? <>Full auto-completion enabled.</> : <>Basic completion for YAML. Switch to JSON for full auto-completion.</>}{' '}
                    <a href='https://argo-workflows.readthedocs.io/en/latest/ide-setup/' target='_blank' rel='noreferrer'>
                        Learn how to get auto-completion in your IDE.
                    </a>
                </div>
            )}
        </>
    );
}

/** Wrapper for ObjectEditor that automatically handles serializing/deserializing the object using useEditableObject() */
export function SerializingObjectEditor<T>({type, value}: {type?: string; value: T}) {
    const {object, setObject, serialization, lang, setLang} = useEditableObject<T>(value);
    return <ObjectEditor type={type} value={object} text={serialization} lang={lang} onLangChange={setLang} onChange={setObject} />;
}
