import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as YAML from 'yaml';

import {configFromAnnotations, parseRunActionLine} from './run-actions';

it('keeps the demo WorkflowTemplate and its two log events compatible with the UI', () => {
    const file = readFileSync(resolve(__dirname, '../../../examples/run-action-demo.yaml'), 'utf8');
    const resources = YAML.parseAllDocuments(file).map(document => document.toJSON());
    expect(resources.map(resource => resource.kind)).toEqual(['ServiceAccount', 'Role', 'RoleBinding', 'WorkflowTemplate']);
    const template = resources[3];
    expect(template.metadata.name).toBe('run-action-demo');
    expect(template.spec.serviceAccountName).toBe('run-action-demo');
    const config = configFromAnnotations(template.metadata.annotations);
    expect(config).toEqual({marker: 'NEEDS_USER_ACTION:', container: 'main'});
    const script: string = template.spec.templates[0].container.args[0];
    const lines = script
        .split('\n')
        .map(line => /^\s*printf '%s\\n' '([^']+)'$/.exec(line)?.[1])
        .filter(Boolean) as string[];
    expect(lines).toHaveLength(2);
    const events = lines.map(line => parseRunActionLine(line, config.marker, ['example.com']));
    expect(events.map(event => event?.id)).toEqual(['demo-1', 'demo-2']);
    expect(events.map(event => event?.code)).toEqual(['DEMO-ONE', 'DEMO-TWO']);
    expect(events.every(event => event?.url === 'https://example.com/')).toBe(true);
    expect(lines.every(line => parseRunActionLine(line, config.marker, []) === null)).toBe(true);
});
