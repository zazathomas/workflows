import {readdirSync, readFileSync} from 'fs';
import {resolve} from 'path';
import * as YAML from 'yaml';

import {ParameterSource, parseParameterSources} from './parameter-sources';
import {ACTION_MARKER_ANNOTATION, configFromAnnotations, parseRunActionLine} from './run-actions';

const examplesDir = resolve(__dirname, '../../../examples');

function exampleDocuments() {
    return readdirSync(examplesDir)
        .filter(name => name.endsWith('.yaml'))
        .flatMap(name =>
            YAML.parseAllDocuments(readFileSync(resolve(examplesDir, name), 'utf8'))
                .map(document => document.toJSON())
                .filter(Boolean)
                .map(resource => ({file: name, resource}))
        );
}

function templates() {
    return exampleDocuments().filter(({resource}) => resource.kind === 'WorkflowTemplate');
}

// Only literal events can be checked without running the script: lines whose JSON
// contains a shell interpolation or a printf placeholder are skipped.
function markedLines(script: string, marker: string): string[] {
    const events: string[] = [];
    for (const raw of script.split('\n')) {
        const line = raw.trim();
        const index = line.indexOf(marker);
        if (index < 0) continue;
        const event = line.slice(index);
        const end = event.lastIndexOf('}');
        if (end < 0) continue;
        const json = event.slice(0, end + 1);
        if (json.includes('${') || json.includes('\\"') || json.includes('"%s"')) continue;
        events.push(json);
    }
    return events;
}

describe('WorkflowTemplate examples', () => {
    const all = templates();

    it('parses every example file', () => {
        expect(all.length).toBeGreaterThanOrEqual(10);
        for (const {file, resource} of all) {
            expect(resource.spec?.entrypoint).toBeTruthy();
            expect(resource.metadata?.namespace).toBe('argo');
            expect(resource.spec?.serviceAccountName).toBeTruthy();
            if (resource.spec?.serviceAccountName === 'wf-runner') {
                expect(resource.spec?.archiveLogs).toBe(false);
            }
            expect(file).toMatch(/\.yaml$/);
        }
    });

    it('declares only supported parameter sources', () => {
        const parameterExamples = all.filter(({resource}) => resource.metadata?.annotations?.['workflows.argoproj.io/parameter-sources']);
        expect(parameterExamples.length).toBeGreaterThanOrEqual(5);

        const problems: string[] = [];
        for (const {file, resource} of parameterExamples) {
            const sources: Record<string, ParameterSource> = parseParameterSources(resource.metadata.annotations);
            if (Object.keys(sources).length === 0) {
                problems.push(`${file}: no sources parsed`);
            }
            const declared = (resource.spec.arguments?.parameters || []).map((parameter: {name: string}) => parameter.name);
            for (const [name, source] of Object.entries(sources)) {
                if (!declared.includes(name)) {
                    problems.push(`${file}: source ${name} has no matching parameter`);
                }
                if (source.url) {
                    const url = new URL(source.url);
                    if (url.protocol !== 'https:' || url.username || source.configMap) {
                        problems.push(`${file}: ${name} must use a plain https url`);
                    }
                } else if (!source.configMap?.name || !source.configMap?.key) {
                    problems.push(`${file}: ${name} needs a url or configMap name and key`);
                }
                if (source.secret && (!source.secret.name || !source.secret.key || !source.secret.header)) {
                    problems.push(`${file}: ${name} has an incomplete secret reference`);
                }
                for (const dependency of source.dependsOn || []) {
                    if (!declared.includes(dependency)) {
                        problems.push(`${file}: ${name} depends on ${dependency}, which is not a parameter`);
                    }
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('declares run actions the UI can parse', () => {
        const actionExamples = all.filter(({resource}) => resource.metadata?.annotations?.[ACTION_MARKER_ANNOTATION]);
        expect(actionExamples.length).toBeGreaterThanOrEqual(6);

        const problems: string[] = [];
        for (const {file, resource} of actionExamples) {
            const config = configFromAnnotations(resource.metadata.annotations);
            if (!config) {
                problems.push(`${file}: invalid marker or container annotation`);
                continue;
            }

            const scripts: string[] = (resource.spec.templates || []).flatMap((template: any) =>
                (template.container ? [template.container] : []).concat(template.sidecars || []).flatMap((container: any) => container.args || [])
            );
            const lines = scripts.flatMap(script => markedLines(String(script), config.marker));
            if (lines.length === 0) {
                problems.push(`${file}: no marked log lines`);
            }

            for (const line of lines) {
                const payload = JSON.parse(line.slice(config.marker.length).replace(/^"|"$/g, ''));
                // now=0 keeps intentionally expired examples valid: this checks shape, not timing.
                const event = parseRunActionLine(line, config.marker, [new URL(payload.url).hostname], 0);
                if (!event || event.id !== payload.id) {
                    problems.push(`${file}: ${payload.id} is not a valid event`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('keeps the device login example self-contained', () => {
        const {resource} = all.find(({file}) => file === 'device-login-run-action.yaml');
        const script: string = resource.spec.templates[0].container.args[0];
        const lines = markedLines(script, configFromAnnotations(resource.metadata.annotations).marker);
        expect(lines).toHaveLength(1);
        expect(script).toContain('if [ -z "$client_id" ]');
        expect(script).toContain('github.com/login/device/code');
    });
});
