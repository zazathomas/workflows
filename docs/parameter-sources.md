# Dynamic parameter sources

The submit form can load parameter options from an HTTPS JSON endpoint or a ConfigMap, optionally authenticating the request with a header read from a Secret.
The server checks that the caller can read the selected template, verifies its annotation, and returns concrete values; the submitted Workflow contains the values and no source configuration.
This returns HTTP 403 in server auth mode and in SSO without RBAC.

## Configure a source

Add the `workflows.argoproj.io/parameter-sources` annotation to the template metadata.
The value is a JSON object whose keys are workflow parameter names; each entry has exactly one of `url` or `configMap`.

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

| Field | Description |
| --- | --- |
| `url` | HTTPS URL fetched with `GET`. `{{parameter}}` and `${parameter}` placeholders are filled from selected values and URL-encoded. |
| `configMap` | ConfigMap source: `name`, `key`, optional `namespace` (defaults to the run namespace). |
| `itemsPath` | JSONPath to the array of options; omit it when the response is the array. |
| `labelPath` | JSONPath to the text shown in the selector. |
| `valuePath` | JSONPath to the string that is submitted. |
| `dependsOn` | Parameters that must have values before the fetch; changing one refreshes the options. |
| `secret` | Optional Secret-backed request header: `name`, `key`, `header`. |

For an array of strings, omit `labelPath` and `valuePath`. Object items need both.
JSONPath expressions may start with `$`; without it the path is relative to the document root.

## ConfigMap sources

```yaml
    workflows.argoproj.io/parameter-sources: |
      {"environment": {"configMap": {"name": "catalog", "key": "environments", "namespace": "argo"},
                       "itemsPath": "items", "labelPath": "name", "valuePath": "id"}}
```

The key must hold JSON with the same shape as an HTTPS response.
The server reads it with the caller's Kubernetes identity, which needs `get` on that ConfigMap; the default namespace is the one receiving the run.
Cross-namespace reads are decided by existing RBAC, not by configuration, and a missing object, key, or permission shows an error in the selector.
No host allowlist entry is needed.

## Allowlist hosts

Set `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` on the argo-server Deployment to a comma-separated list of exact hostnames (no scheme, port, or wildcard):

```yaml
env:
  - name: ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS
    value: catalog.example.com
```

Without it, URL sources are disabled and ConfigMap sources keep working.
The server rejects non-HTTPS URLs, embedded credentials, ports other than 443, hosts outside the list, private and loopback targets, cross-host redirects, responses over 2 MiB, and invalid JSON.
The endpoint is `GET /api/v1/extensions/parameter-options`; the caller names a readable template, its parameter, and the target namespace, and the server builds the URL from the annotation, so callers cannot supply one.
Because it is a GET, interpolated values can appear in proxy logs and browser history: do not interpolate secrets.

## Limits

10 second timeout, 2 MiB response cap, at most 1000 options, and 512 characters per label or value (an oversized source is an error, not truncated output).
Five requests per second with a burst of ten per credential, 32 concurrent fetches per replica (excess gets HTTP 429), and successful responses without Secret headers cached for 30 seconds per template version and URL.
A malformed allowlist entry stops the server at startup, so a typo cannot silently disable a source.

## Secret headers

```json
"repository": {
  "url": "https://catalog.example.com/repositories",
  "itemsPath": "items",
  "labelPath": "displayName",
  "valuePath": "name",
  "secret": {"name": "catalog-credentials", "key": "token", "header": "Authorization"}
}
```

The Secret must be in the run namespace (cross-namespace references are rejected), and the caller's identity needs `get` on it.
Allowlist only endpoints you trust with that header, and restrict who can edit template annotations.
Redirects to another host are rejected when a Secret header is present.

## Examples

Runnable templates in [`examples/`](../examples/README.md): `parameters-url-array.yaml`, `parameters-url-dependent.yaml`, `parameters-configmap.yaml`, `parameters-secret-header.yaml`, and `dynamic-parameters-gist.yaml`.
