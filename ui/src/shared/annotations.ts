export const ANNOTATION_KEY_POD_NAME_VERSION = 'workflows.argoproj.io/pod-name-format';
export const ANNOTATION_TITLE = 'workflows.argoproj.io/title';
export const ANNOTATION_DESCRIPTION = 'workflows.argoproj.io/description';
// An optional, user-supplied note stored on a Run at submission time and shown
// in the run header and lists (Semaphore-style "message" field).
export const ANNOTATION_RUN_MESSAGE = 'workflows.argoproj.io/run-message';
// A launch-form ("survey") definition stored on a Job: a JSON array of
// questions that are rendered when the Job is run (AWX survey pattern).
export const ANNOTATION_SURVEY = 'workflows.argoproj.io/survey';
