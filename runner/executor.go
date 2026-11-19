package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// nonRootUser is the default job container user: nobody:nogroup.
const nonRootUser = "65534:65534"

// ErrArtifactNotAFile marks an artifact path inside the container that is not
// a regular file. This runner transfers single-file artifacts, so a directory
// has to be archived by the job first.
var ErrArtifactNotAFile = errors.New("artifact path is not a regular file (this runner transfers single-file artifacts: archive directories in the job, for example tar -cf /work/out.tgz /work/out)")

// ContainerSpec is the container the executor wants created, after policy.
// The hardening fields are set by the executor (never from the job spec, see
// section 4 of the runners plan) and applied verbatim by the Docker adapter,
// so tests can assert them.
type ContainerSpec struct {
	Name      string
	Image     string
	Command   []string
	Args      []string
	Env       []string // "NAME=VALUE"
	User      string
	NetworkID string
	Runtime   string

	// Hardening (section 4): the job spec has no fields to loosen these.
	CapDrop        []string
	CapAdd         []string
	SecurityOpt    []string
	ReadonlyRootfs bool
	Tmpfs          map[string]string
	PidsLimit      int64
	AllowEgress    bool

	// Resources (zero = daemon default).
	CPUMillis int64
	MemoryMB  int64

	// Mounts: the fresh per-job workspace volume.
	VolumeName string
}

// DockerAPI is the narrow Docker Engine API surface the executor needs. Tests
// provide a fake; the real one wraps github.com/moby/moby/client.
type DockerAPI interface {
	PullImage(ctx context.Context, ref string) error
	CreateNetwork(ctx context.Context, name string, internal bool) (id string, err error)
	RemoveNetwork(ctx context.Context, id string) error
	// CreateVolume creates the per-job workspace volume. sizeMB requests a
	// quota; the returned flag reports whether the driver enforces it.
	CreateVolume(ctx context.Context, name string, sizeMB int64) (quotaEnforced bool, err error)
	RemoveVolume(ctx context.Context, name string) error
	CreateContainer(ctx context.Context, spec ContainerSpec) (id string, err error)
	StartContainer(ctx context.Context, id string) error
	WaitContainer(ctx context.Context, id string) (exitCode int, err error)
	StopContainer(ctx context.Context, id string) error
	RemoveContainer(ctx context.Context, id string, force bool) error
	// CopyFileFromContainer streams a file out of the container (the caller
	// closes it and enforces its own size cap).
	CopyFileFromContainer(ctx context.Context, id, filePath string) (io.ReadCloser, error)
	// CopyFileToContainer streams size bytes into the container at filePath.
	CopyFileToContainer(ctx context.Context, id, filePath string, content io.Reader, size int64) error
	// ContainerLogs streams the container's merged stdout/stderr, following
	// it until the container exits (the stream then ends with EOF).
	ContainerLogs(ctx context.Context, id string) (io.ReadCloser, error)
}

// ArtifactTransfer moves job artifacts and log chunks between argo-server
// and the job container (implemented by the runner client). Uploads stream
// from a seekable source so a whole artifact is never held in memory.
type ArtifactTransfer interface {
	DownloadArtifact(ctx context.Context, jobID, token, name string, dst io.Writer) error
	UploadArtifact(ctx context.Context, jobID, token, name string, content io.ReadSeeker, size int64) error
	AppendLog(ctx context.Context, jobID, token string, offset int64, data []byte) error
}

// Executor runs one job at a time in a hardened container.
type Executor struct {
	docker    DockerAPI
	policy    Policy
	transfers ArtifactTransfer
	log       logging.Logger
}

func NewExecutor(docker DockerAPI, policy Policy) *Executor {
	return &Executor{docker: docker, policy: policy}
}

// WithLogger sets the executor's logger (used for hardening warnings).
func (e *Executor) WithLogger(log logging.Logger) *Executor {
	e.log = log
	return e
}

// WithTransfers wires the artifact transfer client (input downloads and
// output uploads through argo-server).
func (e *Executor) WithTransfers(transfers ArtifactTransfer) *Executor {
	e.transfers = transfers
	return e
}

// Execute runs the job and returns its terminal result. It always cleans up
// the container, network and volume it created.
func (e *Executor) Execute(ctx context.Context, job *api.JobSpec) api.Result {
	if err := e.policy.CheckJob(job); err != nil {
		return api.Result{Phase: api.PhaseError, Message: err.Error()}
	}
	if err := e.verifyImage(ctx, job); err != nil {
		return api.Result{Phase: api.PhaseError, Message: err.Error()}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if !job.Deadline.IsZero() {
		d := time.Until(job.Deadline)
		if d <= 0 {
			return api.Result{Phase: api.PhaseFailed, Message: "job deadline already passed before the container started"}
		}
		timer := time.AfterFunc(d, cancel)
		defer timer.Stop()
	}

	// Per-job network: internal (no egress) unless the policy allows it.
	networkName := "argo-runner-" + sanitizeName(job.ID)
	internal := !e.policy.AllowEgress
	networkID, err := e.docker.CreateNetwork(ctx, networkName, internal)
	if err != nil {
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("creating job network: %v", err)}
	}
	defer func() {
		if err := e.docker.RemoveNetwork(context.WithoutCancel(ctx), networkID); err != nil {
			_ = err // best effort cleanup
		}
	}()

	// Fresh workspace volume per job, with a quota where the driver can
	// enforce one.
	volumeName := "argo-runner-work-" + sanitizeName(job.ID)
	quotaEnforced, err := e.docker.CreateVolume(ctx, volumeName, e.policy.workspaceMB())
	if err != nil {
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("creating workspace volume: %v", err)}
	}
	if !quotaEnforced && e.log != nil {
		e.log.WithField("job", job.ID).WithField("workspaceMB", e.policy.workspaceMB()).Warn(ctx,
			"the Docker volume driver cannot enforce a workspace quota: a job may fill the runner host's disk")
	}
	defer func() {
		_ = e.docker.RemoveVolume(context.WithoutCancel(ctx), volumeName)
	}()

	if err := e.docker.PullImage(ctx, job.Task.Image); err != nil {
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("pulling image %s: %v", job.Task.Image, err)}
	}

	// Docker initialises volume roots as root:root, so a non-root job user
	// could not write its workspace: chown the fresh volume to the job user
	// with a brief container from the job's own (already pulled) image. If
	// the image has no chown (e.g. distroless), continue anyway: such images
	// rarely run shell jobs, and the job result names the failure.
	if !e.policy.AllowRoot {
		if err := e.initWorkspace(ctx, job, volumeName, nonRootUser); err != nil {
			// Best effort: a job that cannot write its workspace fails on
			// its own with a clear container-level error.
			_ = err
		}
	}

	spec := ContainerSpec{
		Name:        sanitizeName(job.ID),
		Image:       job.Task.Image,
		Command:     job.Task.Command,
		Args:        job.Task.Args,
		Env:         envList(job),
		NetworkID:   networkID,
		VolumeName:  volumeName,
		Runtime:     e.policy.Runtime,
		AllowEgress: e.policy.AllowEgress,
		// Hardening defaults. Only the runner-local policy could ever
		// loosen these, never the control plane.
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,noexec,nosuid,size=64m", "/var/tmp": "rw,noexec,nosuid,size=64m"},
		PidsLimit:      512,
	}
	if !e.policy.AllowRoot {
		spec.User = nonRootUser
	}
	// Resources: the job's request, or the operator's defaults. Never zero:
	// an untrusted author could otherwise omit resources and get an unbounded
	// container.
	spec.CPUMillis, spec.MemoryMB = e.policy.jobResources(job)

	containerID, err := e.docker.CreateContainer(ctx, spec)
	if err != nil {
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("creating job container: %v", err)}
	}
	defer func() {
		_ = e.docker.RemoveContainer(context.WithoutCancel(ctx), containerID, true)
	}()

	if err := e.stageInputs(ctx, job, containerID); err != nil {
		return api.Result{Phase: api.PhaseError, Message: err.Error()}
	}

	if err := e.docker.StartContainer(ctx, containerID); err != nil {
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("starting job container: %v", err)}
	}

	// Stream the container log to argo-server while the job runs (live logs
	// in the UI); the pump finishes when the container exits and the stream
	// ends, and is drained before the result is returned.
	logDone := e.streamLogs(ctx, job, containerID, secretValues(job))

	exitCode, err := e.docker.WaitContainer(ctx, containerID)
	if err != nil {
		if ctx.Err() != nil {
			// Cancelled: either the heartbeat said stop, the server context
			// shut down, or the deadline passed.
			_ = e.docker.StopContainer(context.WithoutCancel(ctx), containerID)
			return api.Result{Phase: api.PhaseFailed, Message: fmt.Sprintf("job was cancelled before completion: %v", ctx.Err())}
		}
		return api.Result{Phase: api.PhaseError, Message: fmt.Sprintf("waiting for job container: %v", err)}
	}

	result := api.Result{Phase: api.PhaseSucceeded}
	if exitCode != 0 {
		result.Phase = api.PhaseFailed
		result.Message = fmt.Sprintf("container exited with code %d", exitCode)
	}
	// Output parameters are collected even from failed containers: the
	// workflow author may want diagnostics. A *succeeded* container that did
	// not produce a declared output is an error, though: silently dropping the
	// value leaves the node Succeeded with an output the rest of the workflow
	// references and cannot resolve.
	outputs, outputErr := e.collectOutputs(context.WithoutCancel(ctx), containerID, job)
	result.OutputParameters = outputs
	if outputErr != nil && result.Phase == api.PhaseSucceeded {
		return api.Result{Phase: api.PhaseError, Message: outputErr.Error()}
	}
	if err := e.uploadOutputs(context.WithoutCancel(ctx), job, containerID); err != nil {
		return api.Result{Phase: api.PhaseError, Message: err.Error()}
	}
	<-logDone
	return result
}

// streamLogs pumps the container log to argo-server in ordered chunks. It is
// best effort: log upload failures never fail the job (the runner reports
// what it has and the server assembles the artifact from what arrived).
// Secret values the runner injected are redacted from the stream before it
// leaves the host. The returned channel closes when the pump has fully
// drained the stream.
func (e *Executor) streamLogs(ctx context.Context, job *api.JobSpec, containerID string, secrets []string) chan struct{} {
	done := make(chan struct{})
	if e.transfers == nil {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		stream, err := e.docker.ContainerLogs(ctx, containerID)
		if err != nil {
			return
		}
		defer func() { _ = stream.Close() }()
		// The Docker follow stream ends (EOF) when the container exits,
		// however it exits: normal completion, deadline or cancellation
		// (the executor stops the container). The pump therefore drains the
		// complete log before the result is returned; a cancelled job
		// context only stops further uploads.
		var offset int64
		buf := make([]byte, api.MaxLogChunkBytes)
		// The daemon multiplexes stdout and stderr into 8-byte framed
		// records (stream byte, three zeros, big-endian length) that do not
		// align with our reads: the demuxer keeps a partial frame for the
		// next read instead of dropping it.
		demuxer := &logDemuxer{}
		for {
			n, readErr := stream.Read(buf)
			if n > 0 {
				data, err := demuxer.Decode(buf[:n])
				if err != nil {
					return
				}
				if len(secrets) > 0 {
					data = redactSecrets(data, secrets)
				}
				if len(data) > 0 {
					if err := e.sendLogChunk(ctx, job, offset, data); err != nil {
						// Best effort: stop streaming on permanent failure.
						return
					}
					offset += int64(len(data))
				}
			}
			if readErr != nil {
				return
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()
	return done
}

// sendLogChunk uploads one log chunk with a small retry.
func (e *Executor) sendLogChunk(ctx context.Context, job *api.JobSpec, offset int64, data []byte) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err = e.transfers.AppendLog(ctx, job.ID, job.Token, offset, data)
		if err == nil {
			return nil
		}
		if permanent(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
	}
	return err
}

// redacted is what a secret value is replaced with in the job log.
const redacted = "[REDACTED]"

// secretValues returns the values the job container received from Secrets
// (plus the per-job identity token), which must not reach the server logs. A
// job can still leak a value indirectly (split across a chunk boundary, or
// transformed), so this is best effort.
func secretValues(job *api.JobSpec) []string {
	var values []string
	for _, env := range job.Task.Env {
		if !env.Secret || env.Value == "" {
			continue
		}
		values = append(values, env.Value)
	}
	if job.IdentityToken != "" {
		values = append(values, job.IdentityToken)
	}
	return values
}

// redactSecrets replaces every occurrence of a secret value with [REDACTED].
func redactSecrets(data []byte, secrets []string) []byte {
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		data = bytes.ReplaceAll(data, []byte(secret), []byte(redacted))
	}
	return data
}

// maxFrameBytes bounds a single Docker log record. The daemon reads in much
// smaller pieces, so a larger declared length means the stream is not framed.
const maxFrameBytes = 8 << 20

// logDemuxer strips Docker's log stream framing (stream type, three zero
// bytes, big-endian payload length) across reads. A frame that spans two
// reads is held until its payload arrives: decoding each read on its own
// silently drops every record that a chunk boundary splits.
type logDemuxer struct {
	pending []byte
	// plain is set once the first bytes show the stream is not framed (a TTY
	// stream): everything is then passed through untouched.
	plain bool
}

// Decode returns the payload bytes available after feeding chunk.
func (d *logDemuxer) Decode(chunk []byte) ([]byte, error) {
	if d.plain {
		return chunk, nil
	}
	if d.pending == nil && len(chunk) >= 8 && !isFrameHeader(chunk) {
		// Not framed (a TTY stream): pass everything through from now on.
		d.plain = true
		return chunk, nil
	}
	d.pending = append(d.pending, chunk...)
	if len(d.pending) < 8 {
		return nil, nil // wait for the rest of the header
	}
	if !isFrameHeader(d.pending) {
		// The header only completed across reads and is not valid: treat the
		// stream as plain text rather than dropping output.
		d.plain = true
		out := d.pending
		d.pending = nil
		return out, nil
	}
	var out []byte
	for len(d.pending) >= 8 {
		size := int64(d.pending[4])<<24 | int64(d.pending[5])<<16 | int64(d.pending[6])<<8 | int64(d.pending[7])
		if int64(len(d.pending)-8) < size {
			break // the rest of the record has not arrived yet
		}
		out = append(out, d.pending[8:8+size]...)
		d.pending = d.pending[8+size:]
	}
	if len(d.pending) == 0 {
		d.pending = nil
	} else if cap(d.pending) > 64<<10 {
		// Drop the consumed prefix so the buffer does not grow without bound.
		d.pending = append([]byte(nil), d.pending...)
	}
	return out, nil
}

// isFrameHeader reports whether the first 8 bytes look like a Docker log
// record header.
func isFrameHeader(b []byte) bool {
	if len(b) < 8 {
		return false
	}
	if b[0] > 2 || b[1] != 0 || b[2] != 0 || b[3] != 0 {
		return false
	}
	size := int64(b[4])<<24 | int64(b[5])<<16 | int64(b[6])<<8 | int64(b[7])
	return size >= 0 && size <= maxFrameBytes
}

// initWorkspace chowns a fresh workspace volume to the job user with a
// one-shot container from the job image (volume roots are root-owned). The
// container runs the untrusted job image, so it gets the same hardening as a
// job container plus only the CAP_CHOWN capability it needs, a read-only root
// filesystem and no network.
func (e *Executor) initWorkspace(ctx context.Context, job *api.JobSpec, volumeName, user string) error {
	spec := ContainerSpec{
		Name:       sanitizeName(job.ID) + "-init",
		Image:      job.Task.Image,
		Command:    []string{"/bin/chown"},
		Args:       []string{user, api.WorkspacePath},
		VolumeName: volumeName,
		User:       "0:0",
		// No network: this container only touches the volume.
		NetworkID:      "",
		CapDrop:        []string{"ALL"},
		CapAdd:         []string{"CHOWN"},
		SecurityOpt:    []string{"no-new-privileges"},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,noexec,nosuid,size=16m"},
		PidsLimit:      32,
		CPUMillis:      200,
		MemoryMB:       64,
	}
	id, err := e.docker.CreateContainer(ctx, spec)
	if err != nil {
		return err
	}
	defer func() { _ = e.docker.RemoveContainer(context.WithoutCancel(ctx), id, true) }()
	if err := e.docker.StartContainer(ctx, id); err != nil {
		return err
	}
	if _, err := e.docker.WaitContainer(ctx, id); err != nil {
		return err
	}
	return nil
}

// stageInputs downloads every declared input artifact through argo-server and
// copies it into the job container before it starts. Both hops stream through
// a temporary file, so a large artifact never sits in the runner's memory.
func (e *Executor) stageInputs(ctx context.Context, job *api.JobSpec, containerID string) error {
	if len(job.Task.Inputs.Artifacts) == 0 || e.transfers == nil {
		return nil
	}
	for _, artifact := range job.Task.Inputs.Artifacts {
		if err := api.ValidateArtifactPath(artifact); err != nil {
			return err
		}
		tmp, err := os.CreateTemp("", "argo-runner-input-*")
		if err != nil {
			return fmt.Errorf("staging input artifact %q: %v", artifact.Name, err)
		}
		tmpName := tmp.Name()
		defer func() { _ = os.Remove(tmpName) }()
		// Copy at most one byte past the cap so an oversized artifact is
		// detected without buffering it.
		sized := &countingWriter{w: tmp, limit: api.MaxArtifactBytes}
		if err := e.transfers.DownloadArtifact(ctx, job.ID, job.Token, artifact.Name, sized); err != nil {
			_ = tmp.Close()
			return fmt.Errorf("downloading input artifact %q: %v", artifact.Name, err)
		}
		if sized.overflow {
			_ = tmp.Close()
			return fmt.Errorf("input artifact %q exceeds %d bytes", artifact.Name, api.MaxArtifactBytes)
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			_ = tmp.Close()
			return fmt.Errorf("staging input artifact %q: %v", artifact.Name, err)
		}
		if err := e.docker.CopyFileToContainer(ctx, containerID, artifact.Path, tmp, sized.written); err != nil {
			_ = tmp.Close()
			return fmt.Errorf("placing input artifact %q at %s: %w", artifact.Name, artifact.Path, err)
		}
		_ = tmp.Close()
	}
	return nil
}

// uploadOutputs streams every declared output artifact from the job container
// to argo-server. The container output is spooled to a temporary file (still
// streamed, never read into memory) because the upload proof signs the content
// digest, which must be known before the body is sent.
func (e *Executor) uploadOutputs(ctx context.Context, job *api.JobSpec, containerID string) error {
	if len(job.Task.Outputs.Artifacts) == 0 || e.transfers == nil {
		return nil
	}
	for _, artifact := range job.Task.Outputs.Artifacts {
		if err := api.ValidateArtifactPath(artifact); err != nil {
			return err
		}
		stream, err := e.docker.CopyFileFromContainer(ctx, containerID, artifact.Path)
		if err != nil {
			return fmt.Errorf("reading output artifact %q: %w", artifact.Name, err)
		}
		tmp, err := os.CreateTemp("", "argo-runner-output-*")
		if err != nil {
			_ = stream.Close()
			return fmt.Errorf("staging output artifact %q: %v", artifact.Name, err)
		}
		tmpName := tmp.Name()
		defer func() { _ = os.Remove(tmpName) }()
		size, copyErr := io.Copy(tmp, io.LimitReader(stream, api.MaxArtifactBytes+1))
		closeErr := stream.Close()
		_ = tmp.Close()
		if copyErr != nil || closeErr != nil {
			return fmt.Errorf("reading output artifact %q: %v", artifact.Name, errors.Join(copyErr, closeErr))
		}
		if size > api.MaxArtifactBytes {
			return fmt.Errorf("output artifact %q exceeds %d bytes", artifact.Name, api.MaxArtifactBytes)
		}
		file, err := os.Open(tmpName)
		if err != nil {
			return fmt.Errorf("staging output artifact %q: %v", artifact.Name, err)
		}
		err = e.transfers.UploadArtifact(ctx, job.ID, job.Token, artifact.Name, file, size)
		_ = file.Close()
		if err != nil {
			return fmt.Errorf("uploading output artifact %q: %v", artifact.Name, err)
		}
	}
	return nil
}

// collectOutputs reads declared output parameter files from the workspace.
// Every declared parameter is attempted, so a failed job still reports the
// values it did produce; the first failure is returned alongside them.
func (e *Executor) collectOutputs(ctx context.Context, containerID string, job *api.JobSpec) ([]api.OutputParameter, error) {
	var outputs []api.OutputParameter
	var errs []error
	for _, output := range job.Task.Outputs.Parameters {
		if err := api.ValidateOutputPath(output); err != nil {
			errs = append(errs, err)
			continue
		}
		content, err := e.readContainerFile(ctx, containerID, output.Path, api.MaxOutputParameterBytes)
		if err != nil {
			errs = append(errs, fmt.Errorf("reading output parameter %q from %s: %w", output.Name, output.Path, err))
			continue
		}
		// `echo hello > /work/msg` writes a trailing newline; output
		// parameters conventionally do not include it.
		value := string(bytes.TrimRight(content, "\r\n"))
		outputs = append(outputs, api.OutputParameter{Name: output.Name, Value: value})
	}
	return outputs, errors.Join(errs...)
}

// readContainerFile streams one container file into memory, bounded by limit;
// only small files (output parameters) may be read this way.
func (e *Executor) readContainerFile(ctx context.Context, containerID, filePath string, limit int64) ([]byte, error) {
	stream, err := e.docker.CopyFileFromContainer(ctx, containerID, filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.Close() }()
	content, err := io.ReadAll(io.LimitReader(stream, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > limit {
		return nil, fmt.Errorf("file %q exceeds the %d byte limit", filePath, limit)
	}
	return content, nil
}

// countingWriter counts bytes written to a temporary file and records whether
// the caller's limit was exceeded (the bytes are still written, so the caller
// reports an oversize error actively rather than receiving a truncation).
type countingWriter struct {
	w        io.Writer
	limit    int64
	written  int64
	overflow bool
}

func (c *countingWriter) Write(p []byte) (int, error) {
	if c.limit > 0 && c.written+int64(len(p)) > c.limit {
		c.overflow = true
	}
	n, err := c.w.Write(p)
	c.written += int64(n)
	return n, err
}

func envList(job *api.JobSpec) []string {
	env := make([]string, 0, len(job.Task.Env)+1)
	for _, e := range job.Task.Env {
		if e.SecretKeyRef != nil {
			continue // rejected server-side; never delivered
		}
		env = append(env, e.Name+"="+e.Value)
	}
	// Workload identity: the short-lived per-job OIDC token, when the
	// server mints one. Job containers exchange it for cloud credentials
	// instead of receiving long-lived Secret values.
	if job.IdentityToken != "" {
		env = append(env, api.IdentityTokenEnv+"="+job.IdentityToken)
	}
	return env
}

func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

// mobyDocker adapts github.com/moby/moby/client to DockerAPI.
type mobyDocker struct {
	cli *client.Client
}

// NewMobyDocker connects to the local Docker daemon.
func NewMobyDocker(ctx context.Context, host string) (DockerAPI, error) {
	opts := []client.Opt{client.WithAPIVersionNegotiation()}
	if host != "" {
		opts = append(opts, client.WithHost(host))
	}
	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, err
	}
	if _, err := cli.Ping(ctx, client.PingOptions{}); err != nil {
		return nil, fmt.Errorf("connecting to the Docker daemon: %w", err)
	}
	return &mobyDocker{cli: cli}, nil
}

func (m *mobyDocker) PullImage(ctx context.Context, ref string) error {
	resp, err := m.cli.ImagePull(ctx, ref, client.ImagePullOptions{})
	if err != nil {
		return err
	}
	return resp.Wait(ctx)
}

func (m *mobyDocker) CreateNetwork(ctx context.Context, name string, internal bool) (string, error) {
	result, err := m.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Internal: internal})
	if err != nil {
		return "", err
	}
	return result.ID, nil
}

func (m *mobyDocker) RemoveNetwork(ctx context.Context, id string) error {
	_, err := m.cli.NetworkRemove(ctx, id, client.NetworkRemoveOptions{})
	return err
}

func (m *mobyDocker) CreateVolume(ctx context.Context, name string, sizeMB int64) (bool, error) {
	try := func(opts map[string]string) error {
		_, err := m.cli.VolumeCreate(ctx, client.VolumeCreateOptions{Name: name, DriverOpts: opts})
		return err
	}
	if sizeMB <= 0 {
		return false, try(nil)
	}
	// Ask the volume driver for a quota. Not every driver (or every host)
	// supports one: the local driver rejects size without project quotas. Fall
	// back to an unbounded volume and tell the caller the quota is not
	// enforced, so the operator gets a warning instead of a broken runner.
	if err := try(map[string]string{"size": fmt.Sprintf("%dm", sizeMB)}); err == nil {
		return true, nil
	}
	return false, try(nil)
}

func (m *mobyDocker) RemoveVolume(ctx context.Context, name string) error {
	_, err := m.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{})
	return err
}

func (m *mobyDocker) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	config := &container.Config{
		// The image is passed in ContainerCreateOptions.Image: the daemon
		// rejects both being set ("either Image or config.Image should be").
		User: spec.User,
		Cmd:  spec.Args,
		Env:  spec.Env,
	}
	if len(spec.Command) > 0 {
		config.Entrypoint = spec.Command
	}
	hostConfig := &container.HostConfig{
		CapDrop:        spec.CapDrop,
		CapAdd:         spec.CapAdd,
		SecurityOpt:    spec.SecurityOpt,
		ReadonlyRootfs: spec.ReadonlyRootfs,
		Tmpfs:          spec.Tmpfs,
		PidsLimit:      int64Ptr(spec.PidsLimit),
		NetworkMode:    container.NetworkMode(spec.NetworkID),
		LogConfig:      container.LogConfig{Type: "local", Config: map[string]string{"max-size": "8m", "max-file": "2"}},
		Runtime:        spec.Runtime,
		Binds:          []string{spec.VolumeName + ":" + api.WorkspacePath + ":rw"},
	}
	if spec.NetworkID == "" {
		// Containers that only touch their volume (the workspace init) get no
		// network at all instead of the default bridge.
		hostConfig.NetworkMode = container.NetworkMode("none")
	}
	if spec.CPUMillis > 0 {
		hostConfig.NanoCPUs = spec.CPUMillis * 1_000_000
	}
	if spec.MemoryMB > 0 {
		hostConfig.Memory = spec.MemoryMB * 1024 * 1024
	}
	result, err := m.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name:       spec.Name,
		Image:      spec.Image,
		Config:     config,
		HostConfig: hostConfig,
	})
	if err != nil {
		return "", err
	}
	return result.ID, nil
}

func (m *mobyDocker) StartContainer(ctx context.Context, id string) error {
	_, err := m.cli.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return err
}

func (m *mobyDocker) WaitContainer(ctx context.Context, id string) (int, error) {
	wait := m.cli.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case resp := <-wait.Result:
		return int(resp.StatusCode), nil
	case err := <-wait.Error:
		return 0, err
	}
}

func (m *mobyDocker) StopContainer(ctx context.Context, id string) error {
	timeout := 10
	_, err := m.cli.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &timeout})
	return err
}

// ContainerLogs follows the container's merged output until it exits.
func (m *mobyDocker) ContainerLogs(ctx context.Context, id string) (io.ReadCloser, error) {
	result, err := m.cli.ContainerLogs(ctx, id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Follow: true})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (m *mobyDocker) RemoveContainer(ctx context.Context, id string, force bool) error {
	_, err := m.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: force, RemoveVolumes: true})
	return err
}

// CopyFileToContainer streams size bytes into the container at filePath as a
// single-file tar archive rooted at the workspace, without buffering the
// content. Intermediate directories are part of the archive, so an input
// artifact may be placed at a nested path like /work/src/app/config.yaml.
func (m *mobyDocker) CopyFileToContainer(ctx context.Context, id, filePath string, content io.Reader, size int64) error {
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(writeWorkspaceTar(pw, filePath, content, size))
	}()
	_, err := m.cli.CopyToContainer(ctx, id, client.CopyToContainerOptions{
		DestinationPath: api.WorkspacePath,
		Content:         pr,
	})
	// Unblock the tar-writing goroutine if the daemon stopped reading early.
	_ = pr.CloseWithError(err)
	return err
}

// writeWorkspaceTar writes content at filePath as a tar stream rooted at
// api.WorkspacePath: a directory entry per intermediate component (docker's
// extract creates them), then the file itself. filePath must already have been
// validated to sit under the workspace.
func writeWorkspaceTar(w io.Writer, filePath string, content io.Reader, size int64) error {
	clean := path.Clean(filePath)
	if !strings.HasPrefix(clean, api.WorkspacePath+"/") {
		return fmt.Errorf("artifact path %q is not a file under %s", filePath, api.WorkspacePath)
	}
	rel := strings.TrimPrefix(clean, api.WorkspacePath+"/")
	tw := tar.NewWriter(w)
	var dir string
	parts := strings.Split(rel, "/")
	for _, part := range parts[:len(parts)-1] {
		dir = path.Join(dir, part)
		if err := tw.WriteHeader(&tar.Header{Name: dir + "/", Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
			return err
		}
	}
	if err := tw.WriteHeader(&tar.Header{Name: rel, Mode: 0o644, Size: size, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := io.Copy(tw, content); err != nil {
		return err
	}
	return tw.Close()
}

// CopyFileFromContainer streams a single file out of the container. The
// returned reader yields only that file's bytes (the docker cp tar wrapper is
// consumed transparently) and must be closed by the caller.
func (m *mobyDocker) CopyFileFromContainer(ctx context.Context, id, filePath string) (io.ReadCloser, error) {
	result, err := m.cli.CopyFromContainer(ctx, id, client.CopyFromContainerOptions{SourcePath: filePath})
	if err != nil {
		return nil, err
	}
	stream, err := tarFileStream(result.Content, filePath)
	if err != nil {
		_ = result.Content.Close()
		return nil, err
	}
	return &streamWithCloser{Reader: stream, closer: result.Content}, nil
}

// streamWithCloser closes the underlying docker stream when the file reader is
// closed.
type streamWithCloser struct {
	io.Reader
	closer io.Closer
}

func (s *streamWithCloser) Close() error { return s.closer.Close() }

// tarFileStream advances a docker cp tar stream to the requested file and
// returns a reader positioned at its content.
func tarFileStream(r io.Reader, filePath string) (io.Reader, error) {
	base := path.Base(filePath)
	tr := tar.NewReader(r)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("file %q not found in the container", filePath)
		}
		if err != nil {
			return nil, fmt.Errorf("reading tar: %w", err)
		}
		if path.Base(header.Name) != base {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			// A directory (or symlink, device, ...) at the artifact path: the
			// transfer is single-file only, so say so instead of reporting a
			// missing file.
			return nil, fmt.Errorf("%q: %w", filePath, ErrArtifactNotAFile)
		}
		return tr, nil
	}
}

// fileFromTar extracts a single file from a docker cp tar stream.
func fileFromTar(r io.Reader, filePath string, limit int64) ([]byte, error) {
	base := path.Base(filePath)
	tr := tar.NewReader(r)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("file %q not found in the container", filePath)
		}
		if err != nil {
			return nil, fmt.Errorf("reading tar: %w", err)
		}
		if header.Typeflag != tar.TypeReg || path.Base(header.Name) != base {
			continue
		}
		content, err := io.ReadAll(io.LimitReader(tr, limit+1))
		if err != nil {
			return nil, fmt.Errorf("reading %q: %w", filePath, err)
		}
		if int64(len(content)) > limit {
			return nil, fmt.Errorf("file %q exceeds the output parameter size limit", filePath)
		}
		return content, nil
	}
}

func int64Ptr(v int64) *int64 { return &v }
