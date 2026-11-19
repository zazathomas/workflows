package api

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// Kubernetes object naming, labels and annotations used by both sides of the
// runner extension. Server state lives in the argo-server install namespace:
//
//	pools       ConfigMaps  runner-pool-<pool>
//	runners     Secrets     runner-<runnerID>
//	join tokens Secrets     runner-join-<random>
//	job claims  Leases      runner-job-<nodeHash>-<attempt>
//
// Everything is created by the server (or by `argo-runner admin` with a
// kubeconfig); nothing is a CRD, so no controller changes are needed.
const (
	// LabelComponent discriminates the object kinds managed by the runner
	// extension.
	LabelComponent = "runners.argoproj.io/component"
	// LabelPool is the runner pool, encoded by PoolRefLabelValue.
	LabelPool = "runners.argoproj.io/pool"
	// LabelRunner is the runner ID of the holder (job claims only).
	LabelRunner = "runners.argoproj.io/runner"
	// LabelNodeHash identifies all job claims of one workflow node.
	LabelNodeHash = "runners.argoproj.io/node-hash"
	// LabelSecretAllowed marks a Secret as usable by runner jobs (value
	// "true"). Only marked Secrets in the workflow's own namespace can be
	// delivered to runners.
	LabelSecretAllowed = "runners.argoproj.io/allowed"
	// SecretAllowedValue is the only value of LabelSecretAllowed that grants
	// runner use.
	SecretAllowedValue = "true"
	// AnnotationSecretAllowedPools optionally restricts a marked Secret to a
	// comma-separated list of pool references ("build,tenants/build").
	AnnotationSecretAllowedPools = "runners.argoproj.io/allowed-pools"
	// AnnotationRunnerLabels is the comma-separated capability labels on a
	// runner record ("gpu,arm64").
	AnnotationRunnerLabels = "runners.argoproj.io/labels"
	// AnnotationPoolPaused marks a pool ConfigMap paused: the dispatcher
	// hands out no new jobs from it while set to "true" (running jobs are
	// not interrupted), so hosts can be retired or pools drained.
	AnnotationPoolPaused = "runners.argoproj.io/paused"
	// AnnotationRunnerDrain marks a runner record draining: it receives no
	// new jobs but keeps the ones it holds, so a host can be retired
	// without interrupting running jobs.
	AnnotationRunnerDrain = "runners.argoproj.io/drain"
	// LabelJob identifies the Job (the submitted template) a claim belongs
	// to, encoded by JobLabelValue, so per-Job concurrency can be counted
	// from the claim leases alone.
	LabelJob = "runners.argoproj.io/job"

	ComponentPool      = "runner-pool"
	ComponentRunner    = "runner"
	ComponentJoinToken = "runner-join-token"
	ComponentJob       = "runner-job"

	AnnotationPool           = "runners.argoproj.io/pool"
	AnnotationStatus         = "runners.argoproj.io/status"
	AnnotationKeyFingerprint = "runners.argoproj.io/key-fingerprint"
	AnnotationHostname       = "runners.argoproj.io/hostname"
	AnnotationVersion        = "runners.argoproj.io/version"
	AnnotationFlavour        = "runners.argoproj.io/flavour"
	AnnotationEnrolledAt     = "runners.argoproj.io/enrolled-at"
	AnnotationLastSeen       = "runners.argoproj.io/last-seen"
	AnnotationRotatedAt      = "runners.argoproj.io/rotated-at"
	AnnotationTokenHash      = "runners.argoproj.io/token-hash"
	AnnotationExpiresAt      = "runners.argoproj.io/expires-at"
	AnnotationInstanceID     = "runners.argoproj.io/instance-id"
	AnnotationInstanceKind   = "runners.argoproj.io/instance-kind"
	AnnotationInstanceMeta   = "runners.argoproj.io/instance-meta"
	AnnotationWorkflowUID    = "runners.argoproj.io/workflow-uid"
	AnnotationWorkflowName   = "runners.argoproj.io/workflow-name"
	AnnotationWorkflowNS     = "runners.argoproj.io/workflow-namespace"
	AnnotationNodeID         = "runners.argoproj.io/node-id"
	AnnotationAttempt        = "runners.argoproj.io/attempt"
	// AnnotationClaimArtifacts records output artifacts uploaded through the
	// artifact endpoint during a claim: a JSON map of artifact name to
	// {location, digest, size}. The result writer merges them into the
	// node's outputs.
	AnnotationClaimArtifacts = "runners.argoproj.io/artifacts"

	// DataPublicKey is the raw 32-byte Ed25519 public key in runner Secrets.
	DataPublicKey = "public-key"
	// DataPool is the pool spec JSON in pool ConfigMaps.
	DataPool = "pool"

	// Runner record statuses.
	StatusActive      = "active"
	StatusRevoked     = "revoked"
	StatusQuarantined = "quarantined"
)

// PoolConfigMapName returns the ConfigMap name for a pool.
func PoolConfigMapName(pool string) string {
	return "runner-pool-" + pool
}

// RunnerSecretName returns the Secret name for a runner record.
func RunnerSecretName(runnerID string) string {
	return "runner-" + runnerID
}

// JoinTokenSecretName returns the Secret name for a join token.
func JoinTokenSecretName(id string) string {
	return "runner-join-" + id
}

// ClaimLeaseName returns the Lease name for one claim attempt of a node.
func ClaimLeaseName(nodeHash string, attempt int) string {
	return fmt.Sprintf("runner-job-%s-%d", nodeHash, attempt)
}

// NodeHash derives the stable claim-grouping hash of a workflow node. All
// claims of the same node share the hash.
func NodeHash(workflowUID, nodeID string) string {
	sum := sha256.Sum256([]byte(workflowUID + "\x00" + nodeID))
	return hex.EncodeToString(sum[:])[:24]
}

// KeyFingerprint is a short, non-secret digest of a public key, used to spot
// duplicate enrolments.
func KeyFingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

// PoolRefLabelValue encodes a pool reference as a Kubernetes label value
// ("ns/name" would be invalid; dots are allowed).
func PoolRefLabelValue(ref PoolRef) string {
	if ref.Namespace == "" {
		return ref.Name
	}
	return ref.Namespace + "." + ref.Name
}

// ParsePoolRefLabelValue decodes PoolRefLabelValue.
func ParsePoolRefLabelValue(s string) PoolRef {
	if i := strings.Index(s, "."); i >= 0 {
		return PoolRef{Namespace: s[:i], Name: s[i+1:]}
	}
	return PoolRef{Name: s}
}

// JobLabelValue encodes a Job reference (namespace and template name) as a
// label value. The namespace is a DNS label and never contains a dot, so
// the first dot separates the two.
func JobLabelValue(namespace, name string) string {
	return namespace + "." + name
}

// ParseRunnerLabels splits the comma-separated runner labels annotation.
func ParseRunnerLabels(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var labels []string
	for entry := range strings.SplitSeq(raw, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			labels = append(labels, entry)
		}
	}
	return labels
}

// JoinRunnerLabels renders the comma-separated runner labels annotation.
func JoinRunnerLabels(labels []string) string {
	return strings.Join(labels, ",")
}
