package runner

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

// Client talks to the argo-runner endpoints of an argo-server.
type Client struct {
	base      *url.URL
	http      *http.Client
	key       ed25519.PrivateKey
	runnerID  string
	now       func() time.Time
	userAgent string
}

// NewClient creates a client for the given server base URL.
func NewClient(serverURL string, key ed25519.PrivateKey, runnerID string) (*Client, error) {
	return NewClientWithTLS(serverURL, key, runnerID, nil)
}

// NewClientWithTLS creates a client with a custom TLS configuration.
// InsecureSkipVerify skips the server certificate check: only for
// self-signed servers whose certificate cannot be distributed to the runner
// (the proofs still sign every request, but the transport is then open to
// interception).
func NewClientWithTLS(serverURL string, key ed25519.PrivateKey, runnerID string, tlsConfig *tls.Config) (*Client, error) {
	base, err := url.Parse(serverURL)
	if err != nil {
		return nil, fmt.Errorf("parsing server URL: %w", err)
	}
	if base.Scheme != "https" && base.Scheme != "http" {
		return nil, fmt.Errorf("server URL must be http or https, got %q", serverURL)
	}
	transport := &http.Transport{}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	return &Client{
		base:     base,
		http:     &http.Client{Timeout: 90 * time.Second, Transport: transport},
		key:      key,
		runnerID: runnerID,
		now:      time.Now,
	}, nil
}

// SetTimeout overrides the HTTP timeout (used by tests and fast loops).
func (c *Client) SetTimeout(d time.Duration) {
	c.http.Timeout = d
}

// Enrol exchanges a join token for a runner identity. The attestation is
// optional (required by pools that pin attestation keys). Labels are the
// host's capability labels ("gpu", "arm64") that template `runsOn`
// requirements match against.
func (c *Client) Enrol(ctx context.Context, publicKey ed25519.PublicKey, joinToken, hostname, version, flavour string, labels []string, attestation *api.Attestation) (api.EnrolResponse, error) {
	var resp api.EnrolResponse
	req := api.EnrolRequest{
		JoinToken:   joinToken,
		PublicKey:   api.EncodePublicKey(publicKey),
		Hostname:    hostname,
		Version:     version,
		Flavour:     flavour,
		Labels:      labels,
		Attestation: attestation,
	}
	err := c.post(ctx, "/enrol", req, &resp)
	return resp, err
}

// Claim long-polls for a job.
func (c *Client) Claim(ctx context.Context) (api.ClaimResponse, error) {
	var resp api.ClaimResponse
	err := c.post(ctx, "/claim", nil, &resp)
	return resp, err
}

// Heartbeat renews a claim.
func (c *Client) Heartbeat(ctx context.Context, jobID, token string) (api.HeartbeatResponse, error) {
	var resp api.HeartbeatResponse
	req := api.HeartbeatRequest{JobID: jobID, Token: token}
	err := c.post(ctx, "/heartbeat", req, &resp)
	return resp, err
}

// Result submits a terminal result.
func (c *Client) Result(ctx context.Context, jobID, token string, result api.Result) error {
	req := api.ResultRequest{JobID: jobID, Token: token, Result: result}
	return c.post(ctx, "/result", req, nil)
}

// Rotate replaces the signing key.
func (c *Client) Rotate(ctx context.Context, newPublicKey ed25519.PublicKey) error {
	req := api.RotateRequest{PublicKey: api.EncodePublicKey(newPublicKey)}
	return c.post(ctx, "/rotate", req, nil)
}

// signedRequest builds a proof-signed request for an endpoint path and raw
// query (the query carries the job ID, job token and artifact name on the
// artifact endpoints, and the proof covers it).
func (c *Client) signedRequest(ctx context.Context, method, path, rawQuery string, body io.Reader) (*http.Request, error) {
	u := *c.base
	u.Path = u.Path + api.APIPathPrefix + path
	u.RawQuery = rawQuery
	request, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	// Enrol requests carry no proof (no key exists yet); every other
	// endpoint is signed per request.
	if len(c.key) > 0 {
		var payload []byte
		if body != nil {
			payload, err = io.ReadAll(body)
			if err != nil {
				return nil, fmt.Errorf("reading request body for signing: %w", err)
			}
			if closer, ok := body.(io.Closer); ok {
				_ = closer.Close()
			}
			request.Body = io.NopCloser(bytes.NewReader(payload))
			request.ContentLength = int64(len(payload))
		}
		proof, err := api.BuildProof(c.key, method, u.Path, u.RawQuery, payload, c.now(), api.NewProofNonce())
		if err != nil {
			return nil, fmt.Errorf("signing request: %w", err)
		}
		request.Header.Set(api.RunnerIDHeader, c.runnerID)
		request.Header.Set(api.ProofHeader, proof)
	}
	return request, nil
}

// signedRequestWithDigest builds a proof-signed request whose proof covers
// the given body digest instead of an in-memory body hash (used for large
// artifact uploads; the server verifies the received bytes against the
// digest). The body is streamed, never buffered.
func (c *Client) signedRequestWithDigest(ctx context.Context, path, rawQuery, digest string, body io.Reader, size int64) (*http.Request, error) {
	u := *c.base
	u.Path = u.Path + api.APIPathPrefix + path
	u.RawQuery = rawQuery
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	request.ContentLength = size
	timestamp := api.NewProofTimestamp(c.now())
	nonce := api.NewProofNonce()
	canonical := api.ProofCanonical(http.MethodPost, u.Path, u.RawQuery, digest, timestamp, nonce)
	jws, err := api.SignProof(c.key, canonical)
	if err != nil {
		return nil, fmt.Errorf("signing request: %w", err)
	}
	request.Header.Set(api.RunnerIDHeader, c.runnerID)
	request.Header.Set(api.ProofHeader, jws+" "+timestamp+" "+nonce)
	request.Header.Set(api.BodyDigestHeader, digest)
	return request, nil
}

// DownloadArtifact streams one input artifact of a job to dst. The size cap
// is enforced server-side; the client additionally stops at the cap.
func (c *Client) DownloadArtifact(ctx context.Context, jobID, token, name string, dst io.Writer) error {
	query := url.Values{"job": {jobID}, "token": {token}, "name": {name}}.Encode()
	request, err := c.signedRequest(ctx, http.MethodGet, api.ArtifactInputPath, query, nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("sending request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return &HTTPError{Status: response.StatusCode, Body: string(b)}
	}
	if _, err := io.Copy(dst, io.LimitReader(response.Body, api.MaxArtifactBytes+1)); err != nil {
		return fmt.Errorf("downloading artifact: %w", err)
	}
	return nil
}

// AppendLog uploads one ordered log chunk for a job. The server makes
// appends idempotent, so a retry of the same offset is safe.
func (c *Client) AppendLog(ctx context.Context, jobID, token string, offset int64, data []byte) error {
	query := url.Values{"job": {jobID}, "token": {token}}.Encode()
	body, err := json.Marshal(api.LogChunkRequest{Offset: offset, Data: data})
	if err != nil {
		return fmt.Errorf("marshalling log chunk: %w", err)
	}
	request, err := c.signedRequest(ctx, http.MethodPost, api.LogsEndpoint, query, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("sending request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return &HTTPError{Status: response.StatusCode, Body: string(b)}
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

// UploadArtifact uploads one output artifact of a job. The proof signs the
// SHA-256 of the content so the server can authenticate without buffering,
// and the content is streamed from the (seekable) source: the runner never
// holds a whole artifact in memory.
func (c *Client) UploadArtifact(ctx context.Context, jobID, token, name string, content io.ReadSeeker, size int64) error {
	query := url.Values{"job": {jobID}, "token": {token}, "name": {name}}.Encode()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, content); err != nil {
		return fmt.Errorf("reading artifact %q for upload: %w", name, err)
	}
	if _, err := content.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewinding artifact %q: %w", name, err)
	}
	digest := hex.EncodeToString(hasher.Sum(nil))
	request, err := c.signedRequestWithDigest(ctx, api.ArtifactOutputPath, query, digest, content, size)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("sending request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return &HTTPError{Status: response.StatusCode, Body: string(b)}
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

// post sends a signed POST. An error response (4xx/5xx) is returned as an
// httpError so callers can distinguish "retry" from "give up".
func (c *Client) post(ctx context.Context, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshalling request: %w", err)
		}
	}
	request, err := c.signedRequest(ctx, http.MethodPost, path, "", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("sending request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		return &HTTPError{Status: response.StatusCode, Body: string(b)}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil && err != io.EOF {
		return fmt.Errorf("decoding response: %w", err)
	}
	return nil
}

// HTTPError is a non-2xx response from the server.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	if len(e.Body) > 200 {
		e.Body = e.Body[:200]
	}
	return fmt.Sprintf("server returned HTTP %d: %s", e.Status, e.Body)
}

// Permanent reports whether the error should stop the runner rather than
// be retried.
func (e *HTTPError) Permanent() bool {
	// 401 (bad proof), 403 (revoked/quarantined), 409 (clone) are fatal.
	// 429/5xx are transient.
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict:
		return true
	default:
		return false
	}
}
