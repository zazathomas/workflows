package commands

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	cmdutil "github.com/argoproj/argo-workflows/v4/util/cmd"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// newGateCommand creates `argo-runner gate`: an operator-run signing proxy in
// front of argo-server. The runner points at the gate; the gate forwards
// every request unchanged (runner proofs stay valid: method, path, query and
// body are untouched) and signs the job spec in each claim response with a
// key the server never holds. Runners whose policy pins the gate's public
// key then refuse any job the gate did not sign.
//
// Be precise about the guarantee: the gate signs the claim response the
// argo-server returned, and it does not apply a policy of its own, so it does
// not defend against a compromised argo-server (docs/runners.md, signed job
// specs). What it defends is the transport between the gate and the runner.
func newGateCommand() *cobra.Command {
	var (
		serverURL   string
		listenAddr  string
		keyPath     string
		insecureTLS bool
	)
	command := &cobra.Command{
		Use:   "gate --server URL --key PATH [--listen ADDR]",
		Short: "run the job-signing gate in front of argo-server",
		Long: "Run an operator-local signing proxy between the runner and argo-server.\n" +
			"The gate holds an Ed25519 key (generated on first start, stored under --key) and signs every\n" +
			"claimed job spec. Pin the printed public key in the runner policy's jobSigners; runners then\n" +
			"refuse jobs that did not pass through the gate. The gate signs what the server returned, so\n" +
			"this protects the transport to the runner, not against a compromised argo-server.",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, log, err := cmdutil.ContextWithLogger(cmd, "info", "text")
			if err != nil {
				return err
			}

			key, created, keyErr := loadOrCreateGateKey(keyPath)
			if keyErr != nil {
				return keyErr
			}
			public := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
			if created {
				log.WithField("path", keyPath).Info(ctx, "generated a new gate signing key")
			}
			// The public key is the value to pin in every runner policy.
			fmt.Printf("Gate public key (pin this in runner policies as jobSigners):\n  %s\n", public)

			target, parseErr := url.Parse(serverURL)
			if parseErr != nil {
				return fmt.Errorf("parsing --server: %w", parseErr)
			}
			if target.Scheme != "https" && target.Scheme != "http" {
				return fmt.Errorf("--server must be http or https, got %q", serverURL)
			}

			handler := newGateHandler(target, key, log, insecureTLS)

			log.WithField("listen", listenAddr).WithField("server", serverURL).Info(ctx, "gate listening")
			server := &http.Server{
				Addr:              listenAddr,
				Handler:           handler,
				ReadHeaderTimeout: 10 * time.Second,
			}
			fmt.Printf("Gate listening on %s (forwarding to %s)\n", listenAddr, serverURL)
			return server.ListenAndServe()
		},
	}
	command.Flags().StringVar(&serverURL, "server", envOr("ARGO_RUNNER_SERVER", "https://localhost:2746"), "argo-server base URL to forward to")
	command.Flags().StringVar(&listenAddr, "listen", envOr("ARGO_RUNNER_GATE_LISTEN", "127.0.0.1:8081"), "address the gate listens on (point the runner's --server here)")
	command.Flags().StringVar(&keyPath, "key", envOr("ARGO_RUNNER_GATE_KEY", "/etc/argo-runner/gate-key"), "path for the gate's Ed25519 signing key (generated on first start)")
	command.Flags().BoolVar(&insecureTLS, "insecure-skip-tls-verify", envBool("ARGO_RUNNER_INSECURE_SKIP_TLS_VERIFY"), "skip the upstream server's certificate check (self-signed servers; the transport is then open to interception)")
	return command
}

// gate injects job-spec signatures into claim responses.
type gate struct {
	key ed25519.PrivateKey
	log logging.Logger
}

// signClaimResponse signs the job spec of a successful claim response. Every
// other response passes through unchanged. A response that cannot be
// understood is passed through unsigned: the runner's pinned keys then
// reject the job (fail closed at the runner).
func (g *gate) signClaimResponse(resp *http.Response) error {
	if resp.StatusCode != http.StatusOK || resp.Request == nil {
		return nil
	}
	if !strings.HasPrefix(resp.Request.URL.Path, api.APIPathPrefix+"/claim") {
		return nil
	}
	// Read the body without closing it: responses that are not a decodable
	// claim are put back byte-for-byte and passed through unsigned.
	body, complete, err := readResponseBody(resp, gateClaimBodyLimit)
	if err != nil {
		g.log.WithError(err).Warn(resp.Request.Context(), "gate: could not read claim response; passing it through unsigned")
		return nil
	}
	if !complete {
		// Larger than the gate is willing to buffer (a legal claim can be
		// large: 128 env vars of 128 KiB). It is passed through whole and
		// unsigned, so the runner rejects the job instead of the gate handing
		// back a truncated, undecodable body.
		g.log.WithField("limit", gateClaimBodyLimit).Warn(resp.Request.Context(),
			"gate: claim response exceeds the inspection limit; passing it through unsigned")
		return nil
	}
	var claim api.ClaimResponse
	if err := json.Unmarshal(body, &claim); err != nil || claim.Job == nil {
		return nil
	}
	signature, err := api.SignJobSpec(g.key, claim.Job)
	if err != nil {
		g.log.WithError(err).Warn(resp.Request.Context(), "gate: could not sign the claimed job spec; passing it through unsigned")
		return nil
	}
	claim.Job.SpecSignature = signature
	signed, err := json.Marshal(&claim)
	if err != nil {
		return nil
	}
	setResponseBody(resp, signed)
	g.log.WithField("job", claim.Job.ID).
		WithField("workflow", claim.Job.Workflow.Namespace+"/"+claim.Job.Workflow.Name).
		WithField("node", claim.Job.NodeID).
		WithField("attempt", claim.Job.Attempt).
		WithField("pool", claim.Job.Pool).
		Info(resp.Request.Context(), "gate: signed a claimed job spec")
	return nil
}

// newGateHandler builds the gate's reverse proxy: everything passes through
// untouched (runner proofs stay valid), and successful claim responses get
// their job spec signed.
func newGateHandler(target *url.URL, key ed25519.PrivateKey, log logging.Logger, insecureTLS bool) http.Handler {
	g := &gate{key: key, log: log}
	transport := &http.Transport{
		// The runner's proofs stay valid only while the request is
		// fast; long-poll claims can wait a minute.
		ResponseHeaderTimeout: 2 * time.Minute,
	}
	if insecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec — opt-in, warned in the flag help
	}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
		},
		ModifyResponse: g.signClaimResponse,
		// Claim long-polls and log streams must not be buffered.
		FlushInterval: -1,
		Transport:     transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.WithError(err).Warn(r.Context(), "gate: forwarding failed")
			http.Error(w, "gate: upstream unreachable", http.StatusBadGateway)
		},
	}
}

// gateClaimBodyLimit is how much of a claim response the gate buffers to sign
// it. A larger response is passed through unsigned rather than truncated (the
// runner then rejects the job). Tests lower it.
var gateClaimBodyLimit int64 = api.MaxClaimResponseBytes

// readResponseBody buffers up to limit bytes of a response body and puts the
// body back for the caller (and for the transport) either way. complete is
// false when the body is larger than limit: it is then left as a stream (the
// buffered prefix followed by the rest of the body) rather than truncated.
func readResponseBody(resp *http.Response, limit int64) (body []byte, complete bool, err error) {
	read, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(read)) > limit {
		resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(read), resp.Body))
		resp.ContentLength = -1
		resp.Header.Del("Content-Length")
		return nil, false, nil
	}
	_ = resp.Body.Close()
	setResponseBody(resp, read)
	return read, true, nil
}

// setResponseBody replaces a response body (and its length) with new bytes.
func setResponseBody(resp *http.Response, body []byte) {
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
}

// loadOrCreateGateKey loads the gate's Ed25519 key, generating and storing a
// new one on first start. The key is written 0600: it must never leave the
// gate host.
func loadOrCreateGateKey(path string) (ed25519.PrivateKey, bool, error) {
	if data, err := os.ReadFile(path); err == nil {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(raw) != ed25519.PrivateKeySize {
			return nil, false, fmt.Errorf("gate key %s is not a valid base64 Ed25519 private key", path)
		}
		return ed25519.PrivateKey(raw), false, nil
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, false, fmt.Errorf("generating gate key: %w", err)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, false, fmt.Errorf("creating gate key directory: %w", err)
		}
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	if err := os.WriteFile(path, []byte(encoded+"\n"), 0o600); err != nil {
		return nil, false, fmt.Errorf("storing gate key: %w", err)
	}
	return key, true, nil
}
