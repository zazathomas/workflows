# workflows glossary

Terms the UI uses to distinguish reusable work from its executions, with the Argo Workflows resource behind each one.
See [the README](README.md#ui-terminology-and-argo-workflows) for the full mapping.

## Language

**Job**:
A reusable definition of work that a team can run with parameters.

**Run**:
A single execution of work, with its own status and results. A run may be started from a job or submitted directly.

**Schedule**:
A configuration that starts runs at specified times.

**Run action**:
A request for a person to do something while a run is in progress. Opening the request does not mean the action has succeeded.
