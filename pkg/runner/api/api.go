package api

import "time"

// Package api contains the wire types shared by the argo-server runner
// extension (server side) and the argo-runner binary (runner side). Everything
// that crosses the network between the two lives here so both sides agree on
// field names, encodings and limits.

const (
	// APIPathPrefix is the HTTP prefix all runner endpoints are mounted under.
	// The endpoints are mounted directly on the argo-server HTTP mux and are
	// NOT part of the gRPC/gRPC-gateway API surface: runners authenticate with
	// their own Ed25519 key, not with a Kubernetes identity.
	APIPathPrefix = "/api/v1/extensions/runners/v1"

	// ProofHeader carries a compact JWS (Ed25519) signature over the canonical
	// request string built by ProofCanonical.
	ProofHeader = "X-Argo-Runner-Proof"

	// RunnerIDHeader identifies which runner record the proof must verify
	// against. The header itself is not signed: the signature is always
	// verified against the public key of the named runner, so swapping the
	// header only makes verification fail.
	RunnerIDHeader = "X-Argo-Runner-ID"

	// BodyDigestHeader carries the SHA-256 (hex) of a large request body
	// (artifact uploads). When present on the artifact output endpoint, the
	// proof signs this digest instead of an in-memory body hash, so the
	// server never has to buffer the upload to authenticate it; the handler
	// verifies the received bytes against the digest.
	BodyDigestHeader = "X-Argo-Runner-Body-Digest"

	// ProofTimestampWindow is how far a proof timestamp may be from server
	// time, in either direction (clock skew between runner and server).
	ProofTimestampWindow = 2 * time.Minute

	// DefaultHeartbeatInterval is how often a runner heartbeats while it
	// holds a job claim.
	DefaultHeartbeatInterval = 10 * time.Second

	// ClaimLongPoll is how long the server holds a claim request open before
	// returning an empty response.
	ClaimLongPoll = 30 * time.Second

	// LeaseDurationSeconds is the claim lease duration. A runner must
	// heartbeat within this window or its claim is considered lost.
	LeaseDurationSeconds = 30

	// MaxAttempts is how many times a job may be claimed before it is failed
	// permanently by the reaper.
	MaxAttempts = 3

	// WorkspacePath is the absolute path the job workspace is mounted at
	// inside the job container. Output parameter paths must be under it.
	WorkspacePath = "/work"
)

// Limits enforced by both sides. The server rejects anything larger; the
// runner truncates logs instead of reporting oversized results.
const (
	// MaxMessageBytes caps the result message (per job).
	MaxMessageBytes = 8 << 10
	// MaxOutputParameterBytes caps a single output parameter value.
	MaxOutputParameterBytes = 256 << 10
	// MaxTotalOutputBytes caps the combined output parameters of one job. It
	// is deliberately small: the values are written into
	// `workflowtasksets/status`, which is one object with a hard size budget
	// (a task set over roughly 1.5 MiB makes the controller fail every pending
	// node of the workflow). The server additionally refuses a result that
	// would push the whole task set over its budget.
	MaxTotalOutputBytes = 256 << 10
	// MaxEnvValueBytes caps a single environment variable value.
	MaxEnvValueBytes = 128 << 10
	// MaxEnvVars caps the number of environment variables per job.
	MaxEnvVars = 128
	// MaxArtifactBytes caps a single input or output artifact transferred
	// through argo-server.
	MaxArtifactBytes = 1 << 30
	// MaxArtifactsPerJob caps how many input and output artifacts one job may
	// declare. A job that declared more could make argo-server write an
	// unbounded number of repository objects (and temp files) for one claim.
	MaxArtifactsPerJob = 32
	// MaxRunnerLabels caps how many labels one runner record and one
	// `runsOn` requirement may carry, so the label match and the per-label
	// queue metrics stay bounded.
	MaxRunnerLabels = 8
	// MaxRunnerLabelLength caps one runner label (a DNS label).
	MaxRunnerLabelLength = 32
	// MaxLogChunkBytes caps a single log chunk sent by a runner.
	MaxLogChunkBytes = 256 << 10
	// MaxLogBytes caps the total log output collected for one job.
	MaxLogBytes = 16 << 20
	// MaxClaimResponseBytes caps the claim response body the gate is willing
	// to buffer. A legal claim can be large (MaxEnvVars values of up to
	// MaxEnvValueBytes plus artifacts), so the cap is generous; a larger body
	// is passed through unmodified (and therefore unsigned).
	MaxClaimResponseBytes = 64 << 20
)

// Result phases, wire form. They map onto v1alpha1.NodePhase on the server.
const (
	PhaseSucceeded = "Succeeded"
	PhaseFailed    = "Failed"
	PhaseError     = "Error"
)

// EnrolRequest is the body of POST /enrol.
type EnrolRequest struct {
	// JoinToken is a single-use token minted by argo-runner-broker mint.
	// The broker stores only its SHA-256 digest.
	JoinToken string `json:"joinToken"`
	// PublicKey is the runner's Ed25519 public key, base64 (std) encoded,
	// 32 bytes decoded.
	PublicKey string `json:"publicKey"`
	// Hostname, Version and Flavour are informational and recorded in the
	// runner's metadata for operators.
	Hostname string `json:"hostname,omitempty"`
	Version  string `json:"version,omitempty"`
	Flavour  string `json:"flavour,omitempty"`
	// Labels are capability labels ("gpu", "arm64") recorded on the runner
	// record. A job whose `runsOn` requirement is not a subset of them is
	// never handed to this runner.
	Labels []string `json:"labels,omitempty"`
	// Attestation is optional proof of the joining machine's identity,
	// verified when the pool requires it (for example an AWS EC2 instance
	// identity document). Rejected enrolments fail with a generic message.
	Attestation *Attestation `json:"attestation,omitempty"`
}

// Attestation carries proof of the joining machine's identity.
type Attestation struct {
	// Type selects the verification scheme; pools accept one type.
	Type string `json:"type"`
	// Document is the scheme's signed document (base64).
	Document string `json:"document"`
	// Signature is the scheme's signature over Document (base64).
	Signature string `json:"signature"`
}

// Attestation type for AWS EC2 instance identity documents: the document is
// the IID JSON, the signature an RSA PKCS#1 v1.5 SHA-256 signature by an AWS
// account key the pool pins (fetched from the region's key endpoint and
// verified out of band by the operator).
const AttestationAWSIID = "aws-iid"

// EnrolResponse is the response of a successful enrolment.
type EnrolResponse struct {
	RunnerID string `json:"runnerID"`
	Pool     string `json:"pool"`
	// HeartbeatInterval is a Go duration string.
	HeartbeatInterval string `json:"heartbeatInterval"`
}

// RotateRequest is the body of POST /rotate.
type RotateRequest struct {
	// PublicKey is the runner's new Ed25519 public key, base64 (std) encoded.
	// The request itself must be signed with the OLD key.
	PublicKey string `json:"publicKey"`
}

// ClaimResponse is the response of POST /claim. Job is nil when no job was
// available during the long-poll window.
type ClaimResponse struct {
	Job *JobSpec `json:"job"`
}

// HeartbeatRequest is the body of POST /heartbeat.
type HeartbeatRequest struct {
	JobID string `json:"jobID"`
	Token string `json:"token"`
}

// HeartbeatResponse tells the runner whether to keep running the job.
type HeartbeatResponse struct {
	Continue bool   `json:"continue"`
	Reason   string `json:"reason,omitempty"`
}

// ResultRequest is the body of POST /result.
type ResultRequest struct {
	JobID  string `json:"jobID"`
	Token  string `json:"token"`
	Result Result `json:"result"`
}

// Result is the terminal outcome of a job.
type Result struct {
	Phase   string `json:"phase"`
	Message string `json:"message,omitempty"`
	// OutputParameters are the values read from the job workspace, keyed by
	// parameter name.
	OutputParameters []OutputParameter `json:"outputParameters,omitempty"`
}

// OutputParameter is one output parameter value.
type OutputParameter struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// JobSpec is a job handed to a runner by POST /claim.
type JobSpec struct {
	// ID is the claim lease name. It is also used as the job token subject.
	ID      string `json:"id"`
	Pool    string `json:"pool"`
	Attempt int    `json:"attempt"`
	// Deadline is zero when the template has no timeout.
	Deadline time.Time   `json:"deadline,omitempty"`
	Workflow WorkflowRef `json:"workflow"`
	// NodeID is the workflow node this job fulfils.
	NodeID string      `json:"nodeID"`
	Task   JobTemplate `json:"task"`
	// RunnerID is the runner that claimed the job.
	RunnerID string `json:"runnerID,omitempty"`
	// Token is the single-use job token, bound to the lease and runner. It
	// authorises heartbeat and result submission.
	Token string `json:"token"`
	// IdentityToken is a short-lived OIDC JWT for this job (workload
	// identity), minted when the server is configured with an issuer. The
	// runner injects it into the job container as ARGO_WORKFLOW_IDENTITY.
	IdentityToken string `json:"identityToken,omitempty"`
	// SpecSignature is a compact JWS (Ed25519) over the canonical form of
	// this spec with SpecSignature cleared, produced by an operator-run
	// signer such as `argo-runner gate` (docs/runners.md). Runners whose
	// policy pins signer keys refuse unsigned or wrongly signed specs. Note
	// what that proves: the spec passed through the signer, not that a
	// trusted party composed it. The gate signs what argo-server returned, so
	// this is transport integrity against an on-path attacker, not protection
	// against a compromised argo-server (see the threat model).
	SpecSignature string `json:"specSignature,omitempty"`
}

// WorkflowRef identifies the owning workflow.
type WorkflowRef struct {
	UID       string `json:"uid"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// JobTemplate is the container the runner must run.
type JobTemplate struct {
	Image     string     `json:"image"`
	Command   []string   `json:"command,omitempty"`
	Args      []string   `json:"args,omitempty"`
	Env       []EnvVar   `json:"env,omitempty"`
	Resources *Resources `json:"resources,omitempty"`
	Inputs    JobInputs  `json:"inputs,omitempty"`
	Outputs   JobOutputs `json:"outputs"`
}

// JobInputs are the input artifacts the runner must fetch before the job
// container starts. Each artifact is downloaded through argo-server with the
// job token and placed at Path inside the container.
type JobInputs struct {
	Artifacts []JobArtifact `json:"artifacts,omitempty"`
}

// JobArtifact is one artifact to transfer for a job. Paths are absolute,
// inside the container, and under /work (the workspace volume).
type JobArtifact struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// JobOutputs are the output parameters and artifacts the runner must collect.
type JobOutputs struct {
	Parameters []JobOutputParameter `json:"parameters,omitempty"`
	Artifacts  []JobArtifact        `json:"artifacts,omitempty"`
}

// JobOutputParameter is one output parameter to read from the workspace.
type JobOutputParameter struct {
	Name string `json:"name"`
	// Path is absolute, inside the container, and under /work.
	Path string `json:"path"`
}

// ArtifactEndpoints are the runner-side URLs for artifact transfer, relative
// to APIPathPrefix. The query parameters carry the job ID, job token and
// artifact name; the proofs cover them (see ProofCanonical).
const (
	ArtifactInputPath  = "/artifacts/input"
	ArtifactOutputPath = "/artifacts/output"
)

// LogsEndpoint is the runner-side URL for appending log chunks (relative to
// APIPathPrefix). The query parameters carry the job ID and job token.
const LogsEndpoint = "/logs"

// LogsArtifactName is the name of the output artifact the server assembles
// from a job's log chunks on completion, so the UI's existing archived-log
// path works for runner nodes.
const LogsArtifactName = "main-logs"

// IdentityTokenEnv is the environment variable the runner injects into job
// containers with the job's short-lived OIDC identity token (workload
// identity; see the server's IdentityIssuer).
const IdentityTokenEnv = "ARGO_WORKFLOW_IDENTITY"

// LogChunkRequest is the body of POST <LogsEndpoint>: one ordered chunk of
// the job's container log. Appends are idempotent: a retried chunk (same
// offset) is accepted without duplicating content, and gaps are rejected so
// no output is silently lost.
type LogChunkRequest struct {
	// Offset is the byte offset of Data in the job's log stream.
	Offset int64 `json:"offset"`
	// Data is the chunk content (base64 via Go's []byte JSON encoding).
	Data []byte `json:"data"`
}

// Validate checks the result is well-formed and within limits.
func (r *Result) Validate() error {
	return validateResult(r)
}
