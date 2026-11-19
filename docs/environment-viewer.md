# Environment viewer

**Administration → Environment** lists ConfigMap and Secret names in the selected namespace without requesting their values from Kubernetes.
Select **Show keys** to read one object and display its key names, byte sizes, type, and immutability.
Use **Load more** to follow a Kubernetes continuation token for that kind.
The filter covers names already loaded and keys already opened.

## API

List a page of metadata:

```text
GET /api/v1/extensions/environment?namespace=team-a&view=metadata&kind=Secret
```

The response includes `items` and, if Kubernetes has more results, `continue`.
Pass the token back as `continue` with the same namespace and kind.
If it has expired, restart from the first page.

Get key details without values:

```text
GET /api/v1/extensions/environment?namespace=team-a&view=metadata&kind=Secret&name=registry
```

`kind` is `Secret` or `ConfigMap`.
The legacy request without `view=metadata` returns one bounded page per kind with keys loaded upfront; new clients should use the metadata view.

## Security

The API uses the caller's Kubernetes identity and refuses server auth mode and SSO without RBAC.
Metadata pages use Kubernetes `PartialObjectMetadata` but still require `list` on the resource.
Do not grant `list secrets` just for this UI; that permission also allows full Secret reads directly from Kubernetes.
To expose inventory to users without Secret privileges, publish a separate operator-managed redacted inventory instead.
Details require `get` on the exact object, and values never reach the browser.
