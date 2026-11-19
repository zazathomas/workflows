package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
)

func mustPlugin(t *testing.T, body string) *wfv1.Plugin {
	t.Helper()
	p := &wfv1.Plugin{}
	require.NoError(t, json.Unmarshal([]byte(body), p))
	return p
}

func TestParseRunnerTemplateValid(t *testing.T) {
	p := mustPlugin(t, `{"runner": {
		"pool": "build",
		"image": "docker.io/library/busybox:1.37",
		"command": ["echo"],
		"args": ["hi"],
		"env": [{"name": "FOO", "value": "bar"}, {"name": "TOKEN", "secretKeyRef": {"name": "build-creds", "key": "token"}}],
		"resources": {"cpuMillis": 250, "memoryMB": 128},
		"timeout": "90s"
	}}`)
	rt, err := ParseRunnerTemplate(p)
	require.NoError(t, err)
	assert.Equal(t, "build", rt.Pool)
	assert.Equal(t, "docker.io/library/busybox:1.37", rt.Image)
	require.Len(t, rt.Env, 2)
	assert.Equal(t, EnvVar{Name: "TOKEN", SecretKeyRef: &SecretKeySelector{Name: "build-creds", Key: "token"}}, rt.Env[1])
	d, err := rt.TimeoutDuration()
	require.NoError(t, err)
	assert.Equal(t, 90*time.Second, d)
}

func TestParseRunnerTemplateWrongKey(t *testing.T) {
	p := mustPlugin(t, `{"http": {"url": "http://example.com"}}`)
	_, err := ParseRunnerTemplate(p)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `must be "runner"`)
}

func TestParseRunnerTemplateUnknownField(t *testing.T) {
	p := mustPlugin(t, `{"runner": {"pool": "p", "image": "busybox", "oops": true}}`)
	_, err := ParseRunnerTemplate(p)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown field")
}

func TestParseRunnerTemplateInvalid(t *testing.T) {
	for name, body := range map[string]string{
		"missing pool":    `{"runner": {"image": "busybox"}}`,
		"missing image":   `{"runner": {"pool": "p"}}`,
		"bad pool":        `{"runner": {"pool": "a/b/c", "image": "busybox"}}`,
		"bad image":       `{"runner": {"pool": "p", "image": "!!"}}`,
		"bad env":         `{"runner": {"pool": "p", "image": "busybox", "env": [{"name": "1BAD", "value": "x"}]}}`,
		"bad timeout":     `{"runner": {"pool": "p", "image": "busybox", "timeout": "soon"}}`,
		"secret no key":   `{"runner": {"pool": "p", "image": "busybox", "env": [{"name": "S", "secretKeyRef": {"name": "s"}}]}}`,
		"secret both":     `{"runner": {"pool": "p", "image": "busybox", "env": [{"name": "S", "value": "v", "secretKeyRef": {"name": "s", "key": "k"}}]}}`,
		"secret bad name": `{"runner": {"pool": "p", "image": "busybox", "env": [{"name": "S", "secretKeyRef": {"name": "BadName", "key": "k"}}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseRunnerTemplate(mustPlugin(t, body))
			require.Error(t, err)
		})
	}
}

func TestPoolRef(t *testing.T) {
	p, err := ParsePoolRef("build")
	require.NoError(t, err)
	assert.Equal(t, PoolRef{Name: "build"}, p)
	assert.Equal(t, "build", p.String())

	p, err = ParsePoolRef("tenants/build")
	require.NoError(t, err)
	assert.Equal(t, PoolRef{Namespace: "tenants", Name: "build"}, p)
	assert.Equal(t, "tenants/build", p.String())

	_, err = ParsePoolRef("BadName")
	require.Error(t, err)
	_, err = ParsePoolRef("a/b/c")
	require.Error(t, err)
}

func TestIsDigestPinned(t *testing.T) {
	assert.True(t, IsDigestPinned("busybox@sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"))
	assert.True(t, IsDigestPinned("docker.io/library/busybox@sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"))
	assert.False(t, IsDigestPinned("busybox:1.37"))
	assert.False(t, IsDigestPinned("busybox"))
	assert.False(t, IsDigestPinned("!!"))
}

func TestProofCanonical(t *testing.T) {
	c := ProofCanonical("POST", "/api/v1/extensions/runners/v1/claim", "", BodyHash(nil), "2026-01-02T03:04:05Z", "abc123")
	assert.Equal(t, "argo-runner-proof-v1\nPOST\n/api/v1/extensions/runners/v1/claim\n\n"+
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n2026-01-02T03:04:05Z\nabc123", c)
	// Binding: every component changes the canonical string.
	assert.NotEqual(t, c, ProofCanonical("GET", "/api/v1/extensions/runners/v1/claim", "", BodyHash(nil), "2026-01-02T03:04:05Z", "abc123"))
	assert.NotEqual(t, c, ProofCanonical("POST", "/api/v1/extensions/runners/v1/claim", "", BodyHash([]byte("x")), "2026-01-02T03:04:05Z", "abc123"))
	assert.NotEqual(t, c, ProofCanonical("POST", "/api/v1/extensions/runners/v1/claim", "job=x&token=y", BodyHash(nil), "2026-01-02T03:04:05Z", "abc123"))
}

func TestTimestamps(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	s := NewProofTimestamp(now)
	assert.Equal(t, "2026-01-02T03:04:05Z", s)
	back, err := ParseProofTimestamp(s)
	require.NoError(t, err)
	assert.Equal(t, now, back)
	_, err = ParseProofTimestamp("not a time")
	require.Error(t, err)
}

func TestKeys(t *testing.T) {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i)
	}
	enc := EncodePublicKey(b)
	dec, err := DecodePublicKey(enc)
	require.NoError(t, err)
	assert.Equal(t, b, []byte(dec))
	_, err = DecodePublicKey("!!!")
	require.Error(t, err)
	_, err = DecodePublicKey("aGVsbG8=") // 5 bytes
	require.Error(t, err)
}

func TestHashTokenAndRandomHex(t *testing.T) {
	assert.Equal(t, "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3", HashToken("123"))
	assert.Len(t, RandomHex(16), 32)
	assert.NotEqual(t, RandomHex(16), RandomHex(16))
}

func TestValidateResult(t *testing.T) {
	require.NoError(t, (&Result{Phase: PhaseSucceeded}).Validate())
	require.NoError(t, (&Result{Phase: PhaseFailed, Message: "exit code 1"}).Validate())
	require.Error(t, (&Result{Phase: "Running"}).Validate())
	require.Error(t, (&Result{Phase: PhaseError, Message: string(make([]byte, MaxMessageBytes+1))}).Validate())
	require.Error(t, (&Result{
		Phase:            PhaseSucceeded,
		OutputParameters: []OutputParameter{{Name: "out", Value: string(make([]byte, MaxOutputParameterBytes+1))}},
	}).Validate())
	require.NoError(t, (&Result{
		Phase:            PhaseSucceeded,
		OutputParameters: []OutputParameter{{Name: "out", Value: string(make([]byte, 128))}},
	}).Validate())
	require.Error(t, (&Result{
		Phase:            PhaseSucceeded,
		OutputParameters: []OutputParameter{{Name: "out", Value: string(make([]byte, MaxTotalOutputBytes))}, {Name: "out2", Value: "x"}},
	}).Validate())
}

func TestExtractOutputs(t *testing.T) {
	tmpl := &wfv1.Template{
		Outputs: wfv1.Outputs{
			Parameters: []wfv1.Parameter{
				{Name: "msg", ValueFrom: &wfv1.ValueFrom{Path: "/work/message.txt"}},
				{Name: "literal", Value: wfv1.AnyStringPtr("v")},
			},
			Artifacts: []wfv1.Artifact{
				{Name: "bundle", Path: "/work/out/bundle.tgz"},
				{Name: "no-path"},
			},
		},
	}
	out := ExtractOutputs(tmpl)
	require.Len(t, out.Parameters, 1)
	assert.Equal(t, "msg", out.Parameters[0].Name)
	assert.Equal(t, "/work/message.txt", out.Parameters[0].Path)
	require.Len(t, out.Artifacts, 1)
	assert.Equal(t, "bundle", out.Artifacts[0].Name)
	assert.Equal(t, "/work/out/bundle.tgz", out.Artifacts[0].Path)

	require.NoError(t, ValidateOutputPath(out.Parameters[0]))
	require.NoError(t, ValidateArtifactPath(out.Artifacts[0]))
	require.Error(t, ValidateOutputPath(JobOutputParameter{Name: "x", Path: "/etc/passwd"}))
	require.Error(t, ValidateArtifactPath(JobArtifact{Name: "x", Path: "/work/../etc/passwd"}))
	require.Error(t, ValidateArtifactPath(JobArtifact{Name: "x", Path: "/workdir/file"}))
	require.Error(t, ValidateArtifactPath(JobArtifact{Name: "", Path: "/work/file"}))
}

func TestExtractInputs(t *testing.T) {
	tmpl := &wfv1.Template{
		Inputs: wfv1.Inputs{
			Artifacts: []wfv1.Artifact{
				{Name: "src", Path: "/work/src"},
				{Name: "no-path"},
			},
		},
	}
	in := ExtractInputs(tmpl)
	require.Len(t, in.Artifacts, 1)
	assert.Equal(t, "src", in.Artifacts[0].Name)
	assert.Equal(t, "/work/src", in.Artifacts[0].Path)
	require.NoError(t, ValidateArtifactPath(in.Artifacts[0]))
}

func TestJobSpecSignature(t *testing.T) {
	spec := &JobSpec{
		ID: "runner-job-abc123-1", Pool: "build", Attempt: 2,
		Workflow: WorkflowRef{UID: "uid", Name: "wf", Namespace: "ns"},
		NodeID:   "node-1",
		Task:     JobTemplate{Image: "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"},
		Token:    "job-token",
	}
	_, signerKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	publicKey := signerKey.Public().(ed25519.PublicKey)
	_, otherKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)

	signature, err := SignJobSpec(signerKey, spec)
	require.NoError(t, err)
	assert.NotEmpty(t, signature)

	// A valid signature verifies against the pinned signer key.
	assert.True(t, VerifyJobSpecSignature(spec, signature, []ed25519.PublicKey{publicKey}))

	// The signature does not survive any change to the spec.
	tampered := *spec
	tampered.Task.Image = "docker.io/library/alpine@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"
	assert.False(t, VerifyJobSpecSignature(&tampered, signature, []ed25519.PublicKey{publicKey}))

	// A signature by an unpinned key does not verify.
	forged, err := SignJobSpec(otherKey, spec)
	require.NoError(t, err)
	assert.False(t, VerifyJobSpecSignature(spec, forged, []ed25519.PublicKey{publicKey}))

	// Empty signatures and empty key sets never verify.
	assert.False(t, VerifyJobSpecSignature(spec, "", []ed25519.PublicKey{publicKey}))
	assert.False(t, VerifyJobSpecSignature(spec, signature, nil))

	// A request proof is not a job-spec signature (version separation).
	proof, err := BuildProof(signerKey, "POST", "/claim", "", nil, time.Now(), "nonce")
	require.NoError(t, err)
	assert.False(t, VerifyJobSpecSignature(spec, proof, []ed25519.PublicKey{publicKey}))

	// The signature covers the token, attempt and node identity.
	tampered = *spec
	tampered.Attempt = 3
	assert.False(t, VerifyJobSpecSignature(&tampered, signature, []ed25519.PublicKey{publicKey}))
	tampered = *spec
	tampered.Token = "other-token"
	assert.False(t, VerifyJobSpecSignature(&tampered, signature, []ed25519.PublicKey{publicKey}))
}
