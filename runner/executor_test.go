package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// fakeDocker records every call and simulates a Docker daemon.
type fakeDocker struct {
	mu sync.Mutex

	pulled        []string
	networks      []string // names of created networks
	internal      map[string]bool
	volumes       []string
	created       []ContainerSpec
	started       []string
	removed       []string
	volumeSizes   map[string]int64
	quotaEnforced bool
	// logs, when set, is the framed Docker log stream the fake daemon
	// returns.
	logs []byte
	// exitCode is the exit code of the container; files maps container path
	// to content. blockUntilCancel makes WaitContainer simulate a container
	// that runs until its context is cancelled.
	exitCode         int
	files            map[string]string
	blockUntilCancel bool
	waitCalls        int
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{internal: map[string]bool{}, files: map[string]string{}, volumeSizes: map[string]int64{}}
}

func (f *fakeDocker) PullImage(ctx context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulled = append(f.pulled, ref)
	return nil
}

func (f *fakeDocker) CreateNetwork(ctx context.Context, name string, internal bool) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.networks = append(f.networks, name)
	f.internal[name] = internal
	return "net-" + name, nil
}

func (f *fakeDocker) RemoveNetwork(ctx context.Context, id string) error { return nil }

func (f *fakeDocker) CreateVolume(ctx context.Context, name string, sizeMB int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.volumes = append(f.volumes, name)
	f.volumeSizes[name] = sizeMB
	return f.quotaEnforced, nil
}

func (f *fakeDocker) RemoveVolume(ctx context.Context, name string) error { return nil }

func (f *fakeDocker) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, spec)
	return "ctr-1", nil
}

func (f *fakeDocker) StartContainer(ctx context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, id)
	return nil
}

func (f *fakeDocker) WaitContainer(ctx context.Context, id string) (int, error) {
	f.mu.Lock()
	f.waitCalls++
	code := f.exitCode
	block := f.blockUntilCancel
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return code, ctx.Err()
	}
	return code, nil
}

func (f *fakeDocker) StopContainer(ctx context.Context, id string) error { return nil }

func (f *fakeDocker) RemoveContainer(ctx context.Context, id string, force bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, id)
	return nil
}

// ContainerLogs returns the fake job log; like Docker's follow stream it
// ends (EOF) when the container has produced its output.
func (f *fakeDocker) ContainerLogs(ctx context.Context, id string) (io.ReadCloser, error) {
	f.mu.Lock()
	logs := f.logs
	f.mu.Unlock()
	if len(logs) > 0 {
		return io.NopCloser(bytes.NewReader(logs)), nil
	}
	return io.NopCloser(strings.NewReader("hello from the job\n")), nil
}

func (f *fakeDocker) CopyFileToContainer(ctx context.Context, id, filePath string, content io.Reader, size int64) error {
	data, err := io.ReadAll(content)
	if err != nil {
		return err
	}
	if int64(len(data)) != size {
		return fmt.Errorf("streamed %d bytes, header declared %d", len(data), size)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.files == nil {
		f.files = map[string]string{}
	}
	f.files[filePath] = string(data)
	return nil
}

func (f *fakeDocker) CopyFileFromContainer(ctx context.Context, id, filePath string) (io.ReadCloser, error) {
	f.mu.Lock()
	content, ok := f.files[filePath]
	f.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("no such file: %s", filePath)
	}
	return io.NopCloser(strings.NewReader(content)), nil
}

func testJob() *api.JobSpec {
	return &api.JobSpec{
		ID:       "runner-job-abc123-1",
		Pool:     "build",
		Attempt:  1,
		Workflow: api.WorkflowRef{UID: "uid-1", Name: "wf-1", Namespace: "test"},
		NodeID:   "node-1",
		Task: api.JobTemplate{
			Image:   "docker.io/library/busybox@sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
			Command: []string{"sh", "-c"},
			Args:    []string{"echo hello > /work/message.txt"},
			Env:     []api.EnvVar{{Name: "MODE", Value: "release"}},
			Outputs: api.JobOutputs{Parameters: []api.JobOutputParameter{{Name: "msg", Path: "/work/message.txt"}}},
		},
		Token: "job-token",
	}
}

func testPolicy() Policy {
	return Policy{
		AllowedRegistries: []string{"docker.io"},
		RequireDigest:     true,
		AllowRoot:         false,
	}
}

func TestExecutorSuccessAndOutputs(t *testing.T) {
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor := NewExecutor(docker, testPolicy())
	result := executor.Execute(t.Context(), testJob())

	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	require.Len(t, result.OutputParameters, 1)
	assert.Equal(t, "hello", result.OutputParameters[0].Value) // trailing newline trimmed

	// Two containers: the workspace init (chowns the fresh root-owned volume
	// to the job user) and the job itself.
	require.Len(t, docker.created, 2)
	init, job := docker.created[0], docker.created[1]
	assert.Equal(t, "0:0", init.User, "the workspace init runs as root to chown the volume")
	assert.Equal(t, []string{"/bin/chown"}, init.Command)
	assert.Equal(t, []string{nonRootUser, api.WorkspacePath}, init.Args)
	assert.Empty(t, init.NetworkID, "the workspace init gets no network")
	// The init container runs an untrusted image, so it is hardened too and
	// gets only the one capability chown needs.
	assert.Equal(t, []string{"ALL"}, init.CapDrop)
	assert.Equal(t, []string{"CHOWN"}, init.CapAdd)
	assert.True(t, init.ReadonlyRootfs, "the init container's rootfs is read-only")
	assert.NotEmpty(t, init.PidsLimit, "the init container has a pids limit")

	// Hardening defaults on the job container.
	assert.Equal(t, nonRootUser, job.User, "jobs run as a non-root user by default")
	assert.NotEmpty(t, job.NetworkID)
	assert.Equal(t, []string{"ALL"}, job.CapDrop)
	assert.True(t, job.ReadonlyRootfs)

	// Per-job internal network and fresh volume, both cleaned up. The volume
	// is created with the operator's workspace quota.
	require.Len(t, docker.networks, 1)
	assert.True(t, docker.internal[docker.networks[0]], "network must be internal by default")
	require.Len(t, docker.volumes, 1)
	assert.Equal(t, int64(defaultWorkspaceMB), docker.volumeSizes[docker.volumes[0]], "the workspace volume requests a quota")
	assert.Len(t, docker.removed, 2, "init and job containers removed")
}

// A succeeded container that did not write a declared output parameter is an
// error: the node must not report Succeeded with a value the rest of the
// workflow references and cannot resolve. A failed container still reports
// whatever it produced.
func TestExecutorMissingOutputParameterFailsTheNode(t *testing.T) {
	docker := newFakeDocker()
	job := testJob()
	job.Task.Outputs.Parameters = append(job.Task.Outputs.Parameters, api.JobOutputParameter{Name: "other", Path: "/work/other.txt"})
	docker.files["/work/message.txt"] = "hello\n"

	result := NewExecutor(docker, testPolicy()).Execute(t.Context(), job)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "other")
	assert.Contains(t, result.Message, "/work/other.txt")

	// The failed-container path keeps the values it could read.
	docker = newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	docker.exitCode = 2
	result = NewExecutor(docker, testPolicy()).Execute(t.Context(), job)
	assert.Equal(t, api.PhaseFailed, result.Phase)
	require.Len(t, result.OutputParameters, 1)
	assert.Equal(t, "hello", result.OutputParameters[0].Value)
}

// writeWorkspaceTar roots the archive at the workspace and creates the
// intermediate directories, so an input artifact may be placed at a nested
// path instead of only at /work/<file>.
func TestWriteWorkspaceTarCreatesParentDirectories(t *testing.T) {
	var buf bytes.Buffer
	content := "config: true\n"
	require.NoError(t, writeWorkspaceTar(&buf, "/work/src/app/config.yaml", strings.NewReader(content), int64(len(content))))

	tr := tar.NewReader(&buf)
	var entries []string
	var got string
	for {
		header, err := tr.Next()
		if err != nil {
			break
		}
		entries = append(entries, header.Name)
		if header.Typeflag == tar.TypeReg {
			data, err := io.ReadAll(tr)
			require.NoError(t, err)
			got = string(data)
		}
	}
	assert.Equal(t, []string{"src/", "src/app/", "src/app/config.yaml"}, entries)
	assert.Equal(t, content, got)

	// A path outside the workspace is refused rather than escaping it.
	assert.Error(t, writeWorkspaceTar(io.Discard, "/etc/passwd", strings.NewReader("x"), 1))
}

// A directory at an artifact path is not silently reported as a missing file.
func TestTarFileStreamRejectsDirectories(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	require.NoError(t, tw.WriteHeader(&tar.Header{Name: "out/", Typeflag: tar.TypeDir, Mode: 0o755}))
	require.NoError(t, tw.WriteHeader(&tar.Header{Name: "out/file.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1}))
	_, err := tw.Write([]byte("x"))
	require.NoError(t, err)
	require.NoError(t, tw.Close())

	_, err = tarFileStream(bytes.NewReader(buf.Bytes()), "/work/out")
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrArtifactNotAFile)
}

func TestExecutorFailureExitCode(t *testing.T) {
	docker := newFakeDocker()
	docker.exitCode = 3
	executor := NewExecutor(docker, testPolicy())
	result := executor.Execute(t.Context(), testJob())

	assert.Equal(t, api.PhaseFailed, result.Phase)
	assert.Contains(t, result.Message, "code 3")
}

func TestExecutorPolicyRejections(t *testing.T) {
	job := testJob()

	// Registry not allowed.
	p := testPolicy()
	p.AllowedRegistries = []string{"registry.example.com"}
	executor := NewExecutor(newFakeDocker(), p)
	result := executor.Execute(t.Context(), job)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "allow-list")

	// Not digest-pinned.
	p = testPolicy()
	p2 := Policy{AllowedRegistries: []string{"docker.io"}, RequireDigest: true}
	executor = NewExecutor(newFakeDocker(), p2)
	job2 := testJob()
	job2.Task.Image = "docker.io/library/busybox:latest"
	result = executor.Execute(t.Context(), job2)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "digest")

	// Resource ceiling exceeded.
	p = Policy{AllowedRegistries: []string{"docker.io"}, MaxMemoryMB: 64}
	job3 := testJob()
	job3.Task.Resources = &api.Resources{MemoryMB: 128}
	executor = NewExecutor(newFakeDocker(), p)
	result = executor.Execute(t.Context(), job3)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "ceiling")
}

func TestExecutorOutputPathTraversalRejected(t *testing.T) {
	docker := newFakeDocker()
	executor := NewExecutor(docker, testPolicy())
	job := testJob()
	job.Task.Outputs.Parameters[0].Path = "/etc/passwd"
	result := executor.Execute(t.Context(), job)
	// The output validation fails after the container ran; the result is an
	// error, and no output escapes the workspace.
	assert.Equal(t, api.PhaseError, result.Phase)
}

func TestFileFromTar(t *testing.T) {
	newTar := func() *bytes.Buffer {
		var buf bytes.Buffer
		tw := tar.NewWriter(&buf)
		require.NoError(t, tw.WriteHeader(&tar.Header{Name: "message.txt", Mode: 0o644, Size: 6}))
		_, err := tw.Write([]byte("hello\n"))
		require.NoError(t, err)
		require.NoError(t, tw.Close())
		return &buf
	}

	content, err := fileFromTar(newTar(), "/work/message.txt", 1024)
	require.NoError(t, err)
	assert.Equal(t, "hello\n", string(content))

	// Missing file.
	_, err = fileFromTar(newTar(), "/work/other.txt", 1024)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")

	// Oversize.
	_, err = fileFromTar(newTar(), "/work/message.txt", 3)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "limit")
}

func dockerFrame(stream byte, payload string) []byte {
	b := []byte{stream, 0, 0, 0, byte(len(payload) >> 24), byte(len(payload) >> 16), byte(len(payload) >> 8), byte(len(payload))}
	return append(b, payload...)
}

func TestLogDemuxerAcrossReads(t *testing.T) {
	// Two framed records (stdout then stderr) merge in order.
	in := append(append(dockerFrame(1, "hello "), dockerFrame(2, "world\n")...), dockerFrame(1, "tail")...)
	d := &logDemuxer{}
	out, err := d.Decode(in)
	require.NoError(t, err)
	assert.Equal(t, "hello world\ntail", string(out))

	// A plain-text (TTY) stream passes through untouched.
	d = &logDemuxer{}
	out, err = d.Decode([]byte("plain output\n"))
	require.NoError(t, err)
	assert.Equal(t, "plain output\n", string(out))
	out, err = d.Decode([]byte("more plain\n"))
	require.NoError(t, err)
	assert.Equal(t, "more plain\n", string(out))
}

func TestLogDemuxerSplitFrames(t *testing.T) {
	// One record delivered across three reads must not lose or reorder a
	// single byte: this is the case the old per-read decoder dropped.
	record := dockerFrame(1, "a record that spans three reads")
	trailer := dockerFrame(2, "and a second record")
	stream := append(append([]byte{}, record...), trailer...)

	d := &logDemuxer{}
	var got []byte
	for _, chunk := range [][]byte{stream[:3], stream[3:12], stream[12:19], stream[19:]} {
		out, err := d.Decode(chunk)
		require.NoError(t, err)
		got = append(got, out...)
	}
	assert.Equal(t, "a record that spans three readsand a second record", string(got))

	// A read that ends with a complete record plus the header of the next one
	// keeps the decoded record (the old decoder discarded it).
	d = &logDemuxer{}
	first := dockerFrame(1, "first")
	second := dockerFrame(1, "second")
	out, err := d.Decode(append(append([]byte{}, first...), second[:9]...))
	require.NoError(t, err)
	assert.Equal(t, "first", string(out), "the decoded record must survive the partial trailer")
	out, err = d.Decode(second[9:])
	require.NoError(t, err)
	assert.Equal(t, "second", string(out))
}

func TestLogDemuxerPassesThroughUnframedStreams(t *testing.T) {
	// A header that only completes across reads can still be nonsense: the
	// stream is then treated as plain text rather than buffering a "record"
	// that never arrives.
	d := &logDemuxer{}
	out, err := d.Decode([]byte{1, 0, 0})
	require.NoError(t, err)
	assert.Empty(t, out)
	out, err = d.Decode([]byte{0, 0x7f, 0xff, 0xff, 0xff})
	require.NoError(t, err)
	assert.Equal(t, []byte{1, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff}, out, "the buffered bytes are passed through")
	out, err = d.Decode([]byte("plain"))
	require.NoError(t, err)
	assert.Equal(t, "plain", string(out))
}

func TestExecutorSandboxRuntimePreset(t *testing.T) {
	// The operator selects a sandbox runtime through the runner-local
	// policy (deploy/runners/policy-gvisor.json and friends ship presets);
	// the executor must pass it to every job container. The control plane
	// has no field to set or change it.
	for _, preset := range []string{"policy-gvisor.json", "policy-sysbox.json", "policy-kata.json"} {
		policy, err := LoadPolicy("../deploy/runners/" + preset)
		require.NoError(t, err, preset)
		assert.NotEmpty(t, policy.Runtime, preset)
		assert.True(t, policy.RequireDigest, preset)
		assert.False(t, policy.AllowEgress, preset)
	}

	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor := NewExecutor(docker, Policy{AllowedRegistries: []string{"docker.io"}, RequireDigest: true, Runtime: "runsc"})
	result := executor.Execute(t.Context(), testJob())

	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	require.Len(t, docker.created, 2)
	assert.Equal(t, "runsc", docker.created[1].Runtime, "the job container runs under the policy runtime")
	assert.Empty(t, docker.created[0].Runtime, "the workspace init container needs no sandbox runtime")
}

func TestExecutorRequiresJobSpecSignature(t *testing.T) {
	// With signer keys pinned, an unsigned job fails without a container
	// being created, and a gate-signed job runs.
	_, gateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	gatePublic := base64.StdEncoding.EncodeToString(gateKey.Public().(ed25519.PublicKey))

	p := testPolicy()
	p.JobSigners = []string{gatePublic}

	// Unsigned job: refused before any container exists.
	docker := newFakeDocker()
	executor := NewExecutor(docker, p)
	result := executor.Execute(t.Context(), testJob())
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "signature")
	assert.Empty(t, docker.created, "no container may be created for an unsigned job")

	// Gate-signed job: runs.
	job := testJob()
	signature, err := api.SignJobSpec(gateKey, job)
	require.NoError(t, err)
	job.SpecSignature = signature
	docker = newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor = NewExecutor(docker, p)
	result = executor.Execute(t.Context(), job)
	assert.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	assert.Len(t, docker.created, 2)

	// A signature by an unpinned key: refused.
	_, rogueKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	job = testJob()
	job.SpecSignature, err = api.SignJobSpec(rogueKey, job)
	require.NoError(t, err)
	executor = NewExecutor(newFakeDocker(), p)
	result = executor.Execute(t.Context(), job)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "signature")

	// A malformed pinned key fails the policy load, never silently passes.
	bad := testPolicy()
	bad.JobSigners = []string{"not-base64!!"}
	executor = NewExecutor(newFakeDocker(), bad)
	result = executor.Execute(t.Context(), testJob())
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "jobSigners")
}

func TestExecutorInjectsIdentityToken(t *testing.T) {
	// Workload identity: the short-lived per-job OIDC token arrives in the
	// claim and is injected into the job container's environment.
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor := NewExecutor(docker, testPolicy())
	job := testJob()
	job.IdentityToken = "eyJhbGciOiJFZERTQSJ9.fake.signature"
	result := executor.Execute(t.Context(), job)

	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	require.Len(t, docker.created, 2)
	jobContainer := docker.created[1]
	assert.Contains(t, jobContainer.Env, api.IdentityTokenEnv+"=eyJhbGciOiJFZERTQSJ9.fake.signature")
}

// fakeTransfers records artifact and log traffic (the runner's side of the
// argo-server artifact endpoints).
type fakeTransfers struct {
	mu      sync.Mutex
	inputs  map[string]string
	uploads map[string]string
	sizes   map[string]int64
	logs    []api.LogChunkRequest
}

func newFakeTransfers() *fakeTransfers {
	return &fakeTransfers{inputs: map[string]string{}, uploads: map[string]string{}, sizes: map[string]int64{}}
}

func (f *fakeTransfers) DownloadArtifact(ctx context.Context, jobID, token, name string, dst io.Writer) error {
	f.mu.Lock()
	content, ok := f.inputs[name]
	f.mu.Unlock()
	if !ok {
		return fmt.Errorf("no input artifact %q", name)
	}
	_, err := dst.Write([]byte(content))
	return err
}

func (f *fakeTransfers) UploadArtifact(ctx context.Context, jobID, token, name string, content io.ReadSeeker, size int64) error {
	data, err := io.ReadAll(content)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.uploads[name] = string(data)
	f.sizes[name] = size
	return nil
}

func (f *fakeTransfers) AppendLog(ctx context.Context, jobID, token string, offset int64, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, api.LogChunkRequest{Offset: offset, Data: append([]byte(nil), data...)})
	return nil
}

func TestExecutorAppliesDefaultResourceLimits(t *testing.T) {
	// A job that omits resources must still get limits: the workflow author
	// is untrusted, so omitting the field is the easiest way to ask for an
	// unbounded container.
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor := NewExecutor(docker, Policy{AllowedRegistries: []string{"docker.io"}, RequireDigest: true})
	result := executor.Execute(t.Context(), testJob())
	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	job := docker.created[1]
	assert.Equal(t, int64(defaultJobCPUMillis), job.CPUMillis)
	assert.Equal(t, int64(defaultJobMemoryMB), job.MemoryMB)

	// An explicit request wins, and the operator's ceiling still clamps it.
	job2 := testJob()
	job2.Task.Resources = &api.Resources{CPUMillis: 500, MemoryMB: 256}
	docker = newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor = NewExecutor(docker, Policy{AllowedRegistries: []string{"docker.io"}, RequireDigest: true})
	require.Equal(t, api.PhaseSucceeded, executor.Execute(t.Context(), job2).Phase)
	assert.Equal(t, int64(500), docker.created[1].CPUMillis)
	assert.Equal(t, int64(256), docker.created[1].MemoryMB)

	// Defaults never exceed the ceiling either.
	docker = newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	executor = NewExecutor(docker, Policy{AllowedRegistries: []string{"docker.io"}, RequireDigest: true, DefaultCPUMillis: 8000, MaxCPUMillis: 2000})
	require.Equal(t, api.PhaseSucceeded, executor.Execute(t.Context(), testJob()).Phase)
	assert.Equal(t, int64(2000), docker.created[1].CPUMillis)
}

func TestExecutorWarnsWhenWorkspaceQuotaUnsupported(t *testing.T) {
	// The daemon reports that it cannot enforce the quota: the job still
	// runs, and the executor asks the operator's logger to warn.
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	var warned bool
	log := &recordingLogger{Logger: logging.NewTestLogger(logging.Info, logging.Text), onWarn: func() { warned = true }}
	result := NewExecutor(docker, testPolicy()).WithLogger(log).Execute(t.Context(), testJob())
	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)
	assert.True(t, warned, "an unenforced workspace quota must warn")
}

func TestExecutorRedactsSecretValuesFromLogs(t *testing.T) {
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	docker.logs = dockerFrame(1, "token=s3cr3t-value and auth s3cr3t-value\n")
	transfers := newFakeTransfers()
	executor := NewExecutor(docker, testPolicy()).WithTransfers(transfers)

	job := testJob()
	job.Task.Env = append(job.Task.Env, api.EnvVar{Name: "TOKEN", Value: "s3cr3t-value", Secret: true})
	result := executor.Execute(t.Context(), job)
	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)

	require.NotEmpty(t, transfers.logs)
	var logged []byte
	for _, chunk := range transfers.logs {
		logged = append(logged, chunk.Data...)
	}
	assert.NotContains(t, string(logged), "s3cr3t-value", "the secret value must not reach the server")
	assert.Contains(t, string(logged), redacted)
	assert.Contains(t, string(logged), "token=")
}

func TestExecutorStreamsArtifacts(t *testing.T) {
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	docker.files["/work/out.txt"] = "artifact-content"
	transfers := newFakeTransfers()
	transfers.inputs["in"] = "input-content"

	job := testJob()
	job.Task.Inputs = api.JobInputs{Artifacts: []api.JobArtifact{{Name: "in", Path: "/work/in.txt"}}}
	job.Task.Outputs.Artifacts = []api.JobArtifact{{Name: "out", Path: "/work/out.txt"}}

	executor := NewExecutor(docker, testPolicy()).WithTransfers(transfers)
	result := executor.Execute(t.Context(), job)
	require.Equal(t, api.PhaseSucceeded, result.Phase, result.Message)

	// The input was staged into the container, the output uploaded.
	assert.Equal(t, "input-content", docker.files["/work/in.txt"])
	assert.Equal(t, "artifact-content", transfers.uploads["out"])
	assert.Equal(t, int64(len("artifact-content")), transfers.sizes["out"])
}

// recordingLogger records that a warning was logged. It embeds the real test
// logger for every other method.
type recordingLogger struct {
	logging.Logger
	onWarn func()
}

func (l *recordingLogger) WithField(key string, value any) logging.Logger  { return l }
func (l *recordingLogger) WithFields(fields logging.Fields) logging.Logger { return l }
func (l *recordingLogger) WithError(err error) logging.Logger              { return l }

func (l *recordingLogger) Warn(ctx context.Context, msg string) {
	if l.onWarn != nil {
		l.onWarn()
	}
}
