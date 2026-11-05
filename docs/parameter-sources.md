# Dynamic parameter sources

The embedded UI can load parameter options from an HTTPS JSON endpoint when you submit a WorkflowTemplate or ClusterWorkflowTemplate.
The server checks that the authenticated caller can read the selected template, verifies its annotation, and returns concrete values to the UI.
The submitted Workflow contains the selected values and does not retain the source configuration.
This extension requires client auth mode or SSO with RBAC; it returns HTTP 403 in server auth mode or SSO without RBAC.

## Examples

Runnable WorkflowTemplates live in [`examples/`](../examples/README.md):

- [`parameters-url-array.yaml`](../examples/parameters-url-array.yaml) - the response is an array of strings.
- [`parameters-url-dependent.yaml`](../examples/parameters-url-dependent.yaml) - `{{team}}` in the URL with `dependsOn`, and an `enum` parameter feeding a fetched one.
- [`parameters-configmap.yaml`](../examples/parameters-configmap.yaml) - ConfigMap source with `itemsPath`.
- [`parameters-secret-header.yaml`](../examples/parameters-secret-header.yaml) - a header read from a Kubernetes Secret.
- [`dynamic-parameters-gist.yaml`](../examples/dynamic-parameters-gist.yaml) - two parameters read different arrays from one public gist.

## Configure the source

Add the `workflows.argoproj.io/parameter-sources` annotation to the template metadata.
The annotation value is a JSON object whose keys match workflow parameter names.
Each parameter definition has exactly one of `url` or `configMap`.

```yaml
metadata:
  annotations:
    workflows.argoproj.io/parameter-sources: |
      {
        "environment": {
          "url": "https://catalog.example.com/environments?team={{team}}",
          "itemsPath": "items",
          "labelPath": "name",
          "valuePath": "id",
          "dependsOn": ["team"]
        }
      }
```

Each source supports these fields:

| Field | Description |
| --- | --- |
| `url` | HTTPS URL to fetch with `GET`. Use `{{parameter}}` or `${parameter}` placeholders for selected parameter values. Placeholder values are URL-encoded. |
| `configMap` | ConfigMap source with `name`, `key`, and optional `namespace`. The default namespace is the namespace receiving the run. |
| `itemsPath` | JSONPath to the array of options. If omitted, the response itself must be an array. |
| `labelPath` | JSONPath to the text displayed in the selector for object items. |
| `valuePath` | JSONPath to the string submitted for object items. |
| `dependsOn` | Parameter names that must have values before the source is fetched. Changing a dependency refreshes the source. |
| `secret` | Optional Kubernetes Secret header configuration. |

For a string array, omit `labelPath` and `valuePath`:

```json
{"region": {"url": "https://catalog.example.com/regions", "itemsPath": "items"}}
```

Object items require both paths. JSONPath expressions may start with `$`; expressions without `$` are treated as paths from the document root.

## ConfigMap sources

Set `configMap` instead of `url` to read a JSON document from a ConfigMap key.
By default the ConfigMap is read from the namespace receiving the run.
Set `configMap.namespace` to read it from a shared namespace instead.

```yaml
metadata:
  annotations:
    workflows.argoproj.io/parameter-sources: |
      {
        "environment": {
          "configMap": {
            "name": "catalog",
            "key": "environments",
            "namespace": "argo"
          },
          "itemsPath": "items",
          "labelPath": "name",
          "valuePath": "id"
        }
      }
```

The key must contain valid JSON with the same shape used by HTTPS sources.
The server reads the ConfigMap with the authenticated request's Kubernetes identity.
The identity needs `get` permission on that ConfigMap in the selected namespace.
When `namespace` is omitted, the server uses the namespace receiving the run.
Cross-namespace access is not granted by configuration; existing Kubernetes RBAC decides whether the read succeeds.
A missing ConfigMap, a missing key, or denied access produces an error in the parameter selector.
No host allowlist entry is needed for ConfigMap sources.

## Allowlist hosts

Set the server-only `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` environment variable to a comma-separated list of hostnames:

```yaml
env:
  - name: ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS
    value: catalog.example.com
```

Do not add this setting to the upstream controller's configuration ConfigMap; it rejects unknown fields.
Without this variable, HTTPS URL sources are disabled and ConfigMap sources continue to work.

The server rejects non-HTTPS URLs, embedded URL credentials, ports other than 443, hosts outside this list, private or non-public network targets, failed redirects, responses larger than 2 MiB, and invalid JSON.
The host allowlist applies only to `url` sources.
The endpoint is available at `/api/v1/extensions/parameter-options`.
Requests identify a readable WorkflowTemplate or ClusterWorkflowTemplate, its parameter, and the intended run namespace.
The server builds the URL from the template annotation and submitted parameter values; callers cannot supply a URL.
The endpoint uses GET requests, so interpolated parameter values may appear in proxy logs and browser history.
Do not put credentials or other sensitive values in interpolated parameters.

## Limits

The server fetches with a 10 second timeout and reads at most 2 MiB.
Each credential may make five requests per second with a burst of ten, and each server replica allows 32 concurrent outbound fetches; excess requests receive HTTP 429.
Successful URL responses without Secret headers are cached for 30 seconds by template version and URL.
A source may return at most 1000 options, and each label or value may be at most 512 characters; larger responses are reported as an error instead of being truncated.
Malformed entries in `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` stop the server at startup rather than being ignored, so a typo cannot silently disable a source.

## Secret headers

A source can read a header value from a Kubernetes Secret in the submitting namespace:

```yaml
"repository": {
  "url": "https://catalog.example.com/repositories",
  "itemsPath": "items",
  "labelPath": "displayName",
  "valuePath": "name",
  "secret": {
    "name": "catalog-credentials",
    "key": "token",
    "header": "Authorization"
  }
}
```

The Secret must be in the run namespace; cross-namespace Secret references are rejected.
The caller's Kubernetes identity, or the mapped SSO RBAC service account, must have `get` permission on that Secret.
Allowlist only endpoints you trust with that Secret's header, and restrict who can edit the template annotation.
Redirects to another host are rejected when a Secret header is present.
