#!/usr/bin/env python3
"""Small Argo API used to review the UI without a Kubernetes cluster."""

import json
import re
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ARCHIVE_LABEL = 'workflows.argoproj.io/workflow-archiving-status'
NAMESPACE = 'argo'


def timestamp(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def workflow(name, phase, started_minutes_ago, finished_minutes_ago=None, archived=False, message='', namespace=NAMESPACE):
    uid = f'mock-{namespace}-{name}'
    root_id = name
    prepare_id = f'{name}-prepare'
    execute_id = f'{name}-execute'
    publish_id = f'{name}-publish'
    finished_at = timestamp(finished_minutes_ago) if finished_minutes_ago is not None else None
    labels = {
        'workflows.argoproj.io/phase': phase,
        'workflows.argoproj.io/completed': 'true' if phase in ('Succeeded', 'Failed', 'Error') else 'false',
        'workflows.argoproj.io/workflow-template': 'hello-template',
        'test': 'true',
    }
    if archived:
        labels[ARCHIVE_LABEL] = 'Persisted'

    if phase == 'Running':
        node_phases = ('Succeeded', 'Running', 'Pending')
    elif phase == 'Succeeded':
        node_phases = ('Succeeded', 'Succeeded', 'Succeeded')
    else:
        node_phases = ('Succeeded', phase, 'Pending')

    def node(node_id, display_name, node_phase, offset):
        node_finished = None if node_phase in ('Running', 'Pending') else timestamp(max(0, started_minutes_ago - offset - 2))
        return {
            'id': node_id,
            'name': f'{name}.{display_name}',
            'displayName': display_name,
            'type': 'Pod',
            'phase': node_phase,
            'templateName': 'main',
            'boundaryID': root_id,
            'startedAt': timestamp(max(0, started_minutes_ago - offset)),
            'finishedAt': node_finished,
        }

    return {
        'apiVersion': 'argoproj.io/v1alpha1',
        'kind': 'Workflow',
        'metadata': {
            'name': name,
            'namespace': namespace,
            'uid': uid,
            'resourceVersion': '1',
            'creationTimestamp': timestamp(started_minutes_ago + 1),
            'labels': labels,
            'annotations': {'workflows.argoproj.io/title': name.replace('-', ' ').title()},
        },
        'spec': {
            'entrypoint': 'main',
            'arguments': {
                'parameters': [
                    {'name': 'message', 'value': f'Hello from {name}'},
                    {'name': 'environment', 'default': 'dev'},
                ]
            },
            'templates': [
                {
                    'name': 'main',
                    'inputs': {'parameters': [{'name': 'message'}, {'name': 'environment'}]},
                    'container': {'image': 'alpine:3.20', 'command': ['sh', '-c'], 'args': ['echo {{workflow.parameters.message}}']},
                }
            ],
        },
        'status': {
            'phase': phase,
            'message': message,
            'startedAt': timestamp(started_minutes_ago),
            'finishedAt': finished_at,
            'progress': '1/3' if phase == 'Running' else '3/3',
            'nodes': {
                root_id: {
                    'id': root_id,
                    'name': name,
                    'displayName': name,
                    'type': 'Steps',
                    'phase': phase,
                    'templateName': 'main',
                    'children': [prepare_id, execute_id, publish_id],
                    'startedAt': timestamp(started_minutes_ago),
                    'finishedAt': finished_at,
                    'outboundNodes': [publish_id],
                },
                prepare_id: node(prepare_id, 'prepare', node_phases[0], 0),
                execute_id: node(execute_id, 'execute', node_phases[1], 3),
                publish_id: node(publish_id, 'publish', node_phases[2], 6),
            },
            'conditions': [],
        },
    }


WORKFLOWS = {
    name: workflow(name, phase, started, finished, archived, message, namespace)
    for name, phase, started, finished, archived, message, namespace in [
        ('demo-running', 'Running', 8, None, False, 'Executing the main workflow steps', NAMESPACE),
        ('demo-succeeded', 'Succeeded', 42, 34, False, 'Workflow completed successfully', NAMESPACE),
        ('demo-archived', 'Succeeded', 150, 118, True, 'Archived workflow completed successfully', NAMESPACE),
        ('dev-build', 'Running', 5, None, False, 'Building development artifacts', 'dev'),
        ('dev-test', 'Succeeded', 20, 15, False, 'Development test suite passed', 'dev'),
    ]
}

LOG_LINES = [
    f'[{NAMESPACE}] preparing inputs...\n',
    f'[{NAMESPACE}] executing main step...\n',
    f'[{NAMESPACE}] publish step pending...\n',
]


def workflow_template(name, minutes_ago):
    return {
        'apiVersion': 'argoproj.io/v1alpha1',
        'kind': 'WorkflowTemplate',
        'metadata': {'name': name, 'namespace': NAMESPACE, 'creationTimestamp': timestamp(minutes_ago), 'labels': {'workflows.argoproj.io/workflow-template': name}},
        'spec': WORKFLOWS['demo-succeeded']['spec'],
    }


WORKFLOW_TEMPLATES = [
    workflow_template('hello-template', 60 * 24 * 7),
    workflow_template('etl-template', 60 * 24 * 3),
    workflow_template('report-template', 60 * 24 * 10),
]


def cron_workflow(name, schedule, minutes_ago, suspended=False):
    return {
        'apiVersion': 'argoproj.io/v1alpha1',
        'kind': 'CronWorkflow',
        'metadata': {'name': name, 'namespace': NAMESPACE, 'creationTimestamp': timestamp(minutes_ago), 'labels': {'workflows.argoproj.io/cron-workflow': name}},
        'spec': {'schedules': [schedule], 'timezone': 'UTC', 'suspend': suspended, 'workflowSpec': WORKFLOWS['demo-succeeded']['spec']},
    }


CRON_WORKFLOWS = [
    cron_workflow('nightly-demo', '0 2 * * *', 60 * 24 * 3),
    cron_workflow('hourly-etl', '0 * * * *', 60 * 24 * 1),
    cron_workflow('weekly-report', '0 8 * * 1', 60 * 24 * 5, suspended=True),
]


def collect_namespaces():
    namespaces = set()
    for item in WORKFLOWS.values():
        namespaces.add(item['metadata']['namespace'])
    for item in WORKFLOW_TEMPLATES:
        namespaces.add(item['metadata']['namespace'])
    for item in CRON_WORKFLOWS:
        namespaces.add(item['metadata']['namespace'])
    return sorted(namespaces)


def json_bytes(value):
    return json.dumps(value).encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print(f'[mock] {self.address_string()} - {fmt % args}', flush=True)

    def send_json(self, value, status=200):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == '/api/v1/info':
            return self.send_json({'managedNamespace': '', 'columns': [], 'links': [], 'modals': {}, 'navColor': '#16697a'})
        if path == '/api/v1/namespaces':
            return self.send_json({'items': collect_namespaces()})
        if path == '/api/v1/version':
            return self.send_json({'version': 'v4.1.0-rc2'})
        if path == '/api/v1/userinfo':
            return self.send_json({'subject': 'mock-user', 'serviceAccountNamespace': NAMESPACE})
        if path == '/api/v1/extensions/parameter-options':
            return self.send_json(
                {
                    'items': [
                        {'label': 'Development', 'value': 'dev'},
                        {'label': 'Staging', 'value': 'staging'},
                        {'label': 'Production', 'value': 'prod'},
                    ]
                }
            )
        if path.startswith('/api/v1/workflow-events/'):
            return self.send_sse(path, query)

        log_match = re.fullmatch(r'/api/v1/workflows/([^/]+)/([^/]+)/log', path)
        if log_match:
            return self.send_logs(log_match.group(1), log_match.group(2))

        match = re.fullmatch(r'/api/v1/workflows/([^/]+)(?:/([^/]+))?', path)
        if match:
            namespace, name = match.groups()
            if name:
                selected = WORKFLOWS.get(name)
                if not selected or selected['metadata']['namespace'] != namespace:
                    return self.send_json({'message': 'not found'}, 404)
                return self.send_json(selected)
            items = [item for item in WORKFLOWS.values() if item['metadata']['namespace'] == namespace]
            selector = query.get('listOptions.labelSelector', [''])[0]
            if ' in (Archived,Persisted)' in selector:
                items = [item for item in items if item['metadata']['labels'].get(ARCHIVE_LABEL) in ('Archived', 'Persisted')]
            elif ' notin (Archived,Persisted)' in selector:
                items = [item for item in items if item['metadata']['labels'].get(ARCHIVE_LABEL) not in ('Archived', 'Persisted')]
            phase_match = re.search(r'workflows\.argoproj\.io/phase in \(([^)]*)\)', selector)
            if phase_match:
                wanted_phases = [part.strip() for part in phase_match.group(1).split(',') if part.strip()]
                items = [item for item in items if item['metadata']['labels'].get('workflows.argoproj.io/phase') in wanted_phases]
            name_value = query.get('name', [''])[0]
            field_selector = query.get('listOptions.fieldSelector', [''])[0]
            name_match = re.search(r'(?:^|,)metadata\.name(?:==|=)([^,]+)', field_selector)
            if name_match:
                name_value = name_match.group(1)
            if name_value:
                name_filter = query.get('nameFilter', ['Exact'])[0]
                if name_filter == 'Contains':
                    items = [item for item in items if name_value in item['metadata']['name']]
                elif name_filter == 'Prefix':
                    items = [item for item in items if item['metadata']['name'].startswith(name_value)]
                elif name_filter == 'NotEquals':
                    items = [item for item in items if item['metadata']['name'] != name_value]
                else:
                    items = [item for item in items if item['metadata']['name'] == name_value]
            return self.send_json({'apiVersion': 'v1', 'kind': 'WorkflowList', 'metadata': {'resourceVersion': '1'}, 'items': items})

        if path == f'/api/v1/workflow-templates/{NAMESPACE}':
            templates = list(WORKFLOW_TEMPLATES)
            name_pattern = query.get('namePattern', [''])[0]
            if name_pattern:
                templates = [item for item in templates if name_pattern in item['metadata']['name']]
            return self.send_json({'metadata': {'resourceVersion': '1', 'continue': ''}, 'items': templates})
        if path == f'/api/v1/cron-workflows/{NAMESPACE}':
            return self.send_json({'items': list(CRON_WORKFLOWS)})
        if path == f'/api/v1/event-sources/{NAMESPACE}':
            return self.send_json({'items': []})
        if path == f'/api/v1/sensors/{NAMESPACE}':
            return self.send_json({'items': []})
        if path == f'/api/v1/workflow-event-bindings/{NAMESPACE}':
            return self.send_json({'items': []})
        if path == '/api/v1/cluster-workflow-templates':
            return self.send_json({'items': []})
        if path.startswith('/api/v1/archived-workflows/'):
            uid = path.rsplit('/', 1)[-1]
            for item in WORKFLOWS.values():
                if item['metadata']['uid'] == uid:
                    return self.send_json(item)
            return self.send_json({'message': 'not found'}, 404)
        return self.send_json({'message': 'Not implemented by the mock server'}, 404)

    def send_sse(self, path, query):
        namespace = path.rsplit('/', 1)[-1]
        if namespace != NAMESPACE:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        try:
            self.wfile.write(b': mock event stream\n\n')
            self.wfile.flush()
            field_selector = query.get('listOptions.fieldSelector', [''])[0]
            selected = WORKFLOWS['demo-running']
            name_match = re.search(r'metadata.name=([^,]+)', field_selector)
            if name_match and name_match.group(1) in WORKFLOWS:
                selected = WORKFLOWS[name_match.group(1)]
            time.sleep(3)
            updated = json.loads(json.dumps(selected))
            updated['metadata']['resourceVersion'] = str(int(updated['metadata'].get('resourceVersion', '1')) + 1)
            if updated['status']['phase'] == 'Running':
                updated['status']['progress'] = '2/3'
                updated['status']['message'] = 'Live update received; executing publish step'
                updated['status']['nodes'][f"{updated['metadata']['name']}-execute"]['phase'] = 'Succeeded'
                updated['status']['nodes'][f"{updated['metadata']['name']}-publish"]['phase'] = 'Running'
            payload = {'result': {'type': 'MODIFIED', 'object': updated}}
            self.wfile.write(('data: ' + json.dumps(payload) + '\n\n').encode('utf-8'))
            self.wfile.flush()
            while True:
                time.sleep(20)
                self.wfile.write(b': keep-alive\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_logs(self, namespace, name):
        if namespace != NAMESPACE or name not in WORKFLOWS:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        try:
            for line in LOG_LINES:
                payload = {'result': {'content': line, 'podName': name}}
                self.wfile.write(('data: ' + json.dumps(payload) + '\n\n').encode('utf-8'))
                self.wfile.flush()
                time.sleep(0.3)
            while True:
                time.sleep(20)
                self.wfile.write(b': keep-alive\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 2746), Handler)
    print('Mock Argo API listening on http://127.0.0.1:2746', flush=True)
    server.serve_forever()
