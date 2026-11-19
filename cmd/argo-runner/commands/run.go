package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/argoproj/argo-workflows/v4"
	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/runner"
	cmdutil "github.com/argoproj/argo-workflows/v4/util/cmd"
)

// newEnrolCommand creates `argo-runner enrol`: exchange a single-use join
// token for a runner identity stored under the credentials directory.
func newEnrolCommand() *cobra.Command {
	var (
		serverURL       string
		joinToken       string
		credsDir        string
		hostname        string
		flavour         string
		attestationType string
		insecureTLS     bool
		runnerLabels    []string
	)
	command := &cobra.Command{
		Use:   "enrol",
		Short: "enrol this host as a runner with a join token",
		RunE: func(cmd *cobra.Command, args []string) error {
			if joinToken == "" {
				return fmt.Errorf("--join-token is required (mint one with `argo-runner-broker mint`)")
			}
			resp, err := enrol(cmd.Context(), serverURL, joinToken, credsDir, hostname, flavour, runnerLabels, attestationType, insecureTLS)
			if err != nil {
				return err
			}
			fmt.Printf("Enrolled as runner %s in pool %s. Credentials saved to %s.\n", resp.RunnerID, resp.Pool, credsDir)
			return nil
		},
	}
	command.Flags().StringVar(&serverURL, "server", envOr("ARGO_RUNNER_SERVER", "https://localhost:2746"), "argo-server base URL")
	command.Flags().StringVar(&joinToken, "join-token", os.Getenv("ARGO_RUNNER_JOIN_TOKEN"), "single-use join token")
	command.Flags().StringVar(&credsDir, "credentials-dir", envOr("ARGO_RUNNER_CREDENTIALS_DIR", "/etc/argo-runner"), "directory for the runner credentials (created 0700)")
	command.Flags().StringVar(&hostname, "hostname", "", "informational hostname recorded with the runner (defaults to the system hostname)")
	command.Flags().StringVar(&flavour, "flavour", "native", "informational executor flavour (native or dind)")
	command.Flags().StringSliceVar(&runnerLabels, "labels", envSlice("ARGO_RUNNER_LABELS"), "capability labels for this host (gpu, arm64), matched by template runsOn requirements")
	command.Flags().StringVar(&attestationType, "attestation", os.Getenv("ARGO_RUNNER_ATTESTATION"), "proof of this machine's identity for pools that require it (aws-iid: the EC2 instance identity document)")
	command.Flags().BoolVar(&insecureTLS, "insecure-skip-tls-verify", envBool("ARGO_RUNNER_INSECURE_SKIP_TLS_VERIFY"), "skip the server certificate check (self-signed servers; the transport is then open to interception)")
	return command
}

// envSlice reads a comma-separated environment variable as a list.
func envSlice(name string) []string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return nil
	}
	var items []string
	for entry := range strings.SplitSeq(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			items = append(items, entry)
		}
	}
	return items
}

// fetchAttestation collects this machine's proof of identity.
func fetchAttestation(ctx context.Context, attestationType string) (*api.Attestation, error) {
	switch attestationType {
	case api.AttestationAWSIID:
		return fetchAWSIID(ctx)
	default:
		return nil, fmt.Errorf("unsupported attestation type %q (supported: %s)", attestationType, api.AttestationAWSIID)
	}
}

// fetchAWSIID reads the EC2 instance identity document and its signature
// from the instance metadata service (IMDSv2 token hop included).
func fetchAWSIID(ctx context.Context) (*api.Attestation, error) {
	const imds = "http://169.254.169.254/latest"
	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPut, imds+"/api/token", nil)
	if err != nil {
		return nil, err
	}
	tokenReq.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "300")
	tokenResp, err := http.DefaultClient.Do(tokenReq)
	if err != nil {
		return nil, fmt.Errorf("requesting the IMDSv2 token (is this an EC2 instance?): %w", err)
	}
	token, err := io.ReadAll(tokenResp.Body)
	tokenResp.Body.Close()
	if err != nil || len(token) == 0 {
		return nil, fmt.Errorf("no IMDSv2 token: the metadata service did not answer")
	}
	get := func(path string) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, imds+path, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-aws-ec2-metadata-token", string(token))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	}
	document, err := get("/dynamic/instance-identity/document")
	if err != nil {
		return nil, fmt.Errorf("reading the instance identity document: %w", err)
	}
	signature, err := get("/dynamic/instance-identity/signature")
	if err != nil {
		return nil, fmt.Errorf("reading the instance identity signature: %w", err)
	}
	return &api.Attestation{
		Type:      api.AttestationAWSIID,
		Document:  base64.StdEncoding.EncodeToString(bytes.TrimSpace(document)),
		Signature: base64.StdEncoding.EncodeToString(bytes.TrimSpace(signature)),
	}, nil
}

// enrol exchanges a single-use join token for a runner identity stored
// under the credentials directory. An attestation type fetches the joining
// machine's proof of identity (for example the EC2 instance identity
// document from the metadata service) for pools that require it.
func newKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

func argoVersion() string { return argo.GetVersion().Version }

func enrol(ctx context.Context, serverURL, joinToken, credsDir, hostname, flavour string, runnerLabels []string, attestationType string, insecureTLS bool) (api.EnrolResponse, error) {
	publicKey, privateKey, err := newKey()
	if err != nil {
		return api.EnrolResponse{}, err
	}
	client, err := runnerClient(serverURL, nil, "", insecureTLS)
	if err != nil {
		return api.EnrolResponse{}, err
	}
	var attestation *api.Attestation
	if attestationType != "" {
		attestation, err = fetchAttestation(ctx, attestationType)
		if err != nil {
			return api.EnrolResponse{}, err
		}
	}
	resp, err := client.Enrol(ctx, publicKey, joinToken, hostname, argoVersion(), flavour, runnerLabels, attestation)
	if err != nil {
		return api.EnrolResponse{}, fmt.Errorf("enrolment failed: %w", err)
	}
	if err := runner.SaveCredentials(credsDir, &runner.Credentials{
		RunnerID:   resp.RunnerID,
		Pool:       resp.Pool,
		PrivateKey: privateKey,
		ServerURL:  serverURL,
	}); err != nil {
		return api.EnrolResponse{}, err
	}
	return resp, nil
}

// newRunCommand creates `argo-runner run`: the claim loop.
func newRunCommand() *cobra.Command {
	var (
		credsDir    string
		policyPath  string
		dockerHost  string
		once        bool
		insecureTLS bool
		joinToken   string
		serverURL   string
		flavour     string
	)
	command := &cobra.Command{
		Use:   "run",
		Short: "claim and run jobs until stopped",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			creds, err := runner.LoadCredentials(credsDir)
			if err != nil {
				// A join token (flag or env) enrols on first start, so a
				// fresh host runs with one invocation; drop it after.
				if joinToken == "" {
					return fmt.Errorf("%w (enrol first with `argo-runner enrol`, or pass --join-token)", err)
				}
				hostname, _ := os.Hostname()
				resp, enrolErr := enrol(ctx, serverURL, joinToken, credsDir, hostname, flavour, envSlice("ARGO_RUNNER_LABELS"), "", insecureTLS)
				if enrolErr != nil {
					return fmt.Errorf("no saved credentials (%v) and enrolment failed: %w", err, enrolErr)
				}
				fmt.Printf("Enrolled as runner %s in pool %s. Credentials saved to %s.\n", resp.RunnerID, resp.Pool, credsDir)
				creds, err = runner.LoadCredentials(credsDir)
				if err != nil {
					return err
				}
			}
			key, err := creds.Key()
			if err != nil {
				return err
			}
			policy, err := runner.LoadPolicy(policyPath)
			if err != nil {
				return err
			}
			docker, err := runner.NewMobyDocker(ctx, dockerHost)
			if err != nil {
				return err
			}
			client, err := runnerClient(creds.ServerURL, key, creds.RunnerID, insecureTLS)
			if err != nil {
				return err
			}
			logCtx, logger, err := cmdutil.ContextWithLogger(cmd, "info", "text")
			if err != nil {
				return err
			}
			if policy.AllowEgress {
				logger.Warn(logCtx, "runner policy allows egress: job containers can reach every network this host can, including cloud metadata services (169.254.169.254) and private ranges")
			}
			loop := runner.NewLoop(runner.LoopConfig{
				Client:   client,
				Executor: runner.NewExecutor(docker, policy).WithLogger(logger),
				Log:      logger,
				Once:     once,
			})
			return loop.Run(logCtx)
		},
	}
	command.Flags().StringVar(&credsDir, "credentials-dir", envOr("ARGO_RUNNER_CREDENTIALS_DIR", "/etc/argo-runner"), "directory holding the runner credentials")
	command.Flags().StringVar(&policyPath, "policy", envOr("ARGO_RUNNER_POLICY", "/etc/argo-runner/policy.json"), "runner-local policy file (required)")
	command.Flags().StringVar(&dockerHost, "docker-host", os.Getenv("DOCKER_HOST"), "Docker daemon to run jobs with")
	command.Flags().BoolVar(&once, "once", false, "claim and run a single job, then exit (recommended for untrusted authors on throwaway hosts)")
	command.Flags().BoolVar(&insecureTLS, "insecure-skip-tls-verify", envBool("ARGO_RUNNER_INSECURE_SKIP_TLS_VERIFY"), "skip the server certificate check (self-signed servers; the transport is then open to interception)")
	command.Flags().StringVar(&joinToken, "join-token", os.Getenv("ARGO_RUNNER_JOIN_TOKEN"), "single-use join token: enrols a fresh host on first start")
	command.Flags().StringVar(&serverURL, "server", envOr("ARGO_RUNNER_SERVER", "https://localhost:2746"), "argo-server base URL (used for first-start enrolment)")
	command.Flags().StringVar(&flavour, "flavour", "native", "informational executor flavour recorded at first-start enrolment (native or dind)")
	return command
}

// newRotateCommand creates `argo-runner rotate`: replace this runner's signing
// key with a fresh one. The request is signed with the old key, the server
// drops the old key immediately, and the new key is written to the credentials
// directory.
func newRotateCommand() *cobra.Command {
	var (
		credsDir    string
		serverURL   string
		insecureTLS bool
	)
	command := &cobra.Command{
		Use:   "rotate",
		Short: "replace this runner's signing key (signed with the old key)",
		RunE: func(cmd *cobra.Command, args []string) error {
			creds, err := runner.LoadCredentials(credsDir)
			if err != nil {
				return err
			}
			oldKey, err := creds.Key()
			if err != nil {
				return err
			}
			publicKey, privateKey, err := newKey()
			if err != nil {
				return err
			}
			target := creds.ServerURL
			if serverURL != "" {
				target = serverURL
			}
			client, err := runnerClient(target, oldKey, creds.RunnerID, insecureTLS)
			if err != nil {
				return err
			}
			if err := client.Rotate(cmd.Context(), publicKey); err != nil {
				return fmt.Errorf("rotation failed (the old key is still valid): %w", err)
			}
			creds.PrivateKey = privateKey
			creds.ServerURL = target
			if err := runner.SaveCredentials(credsDir, creds); err != nil {
				return fmt.Errorf("the server now expects the new key, but the credentials could not be saved: %w", err)
			}
			fmt.Printf("Rotated the signing key of runner %s. Credentials saved to %s.\n", creds.RunnerID, credsDir)
			return nil
		},
	}
	command.Flags().StringVar(&credsDir, "credentials-dir", envOr("ARGO_RUNNER_CREDENTIALS_DIR", "/etc/argo-runner"), "directory holding the runner credentials")
	command.Flags().StringVar(&serverURL, "server", "", "argo-server base URL (defaults to the enrolled server)")
	command.Flags().BoolVar(&insecureTLS, "insecure-skip-tls-verify", envBool("ARGO_RUNNER_INSECURE_SKIP_TLS_VERIFY"), "skip the server certificate check (self-signed servers; the transport is then open to interception)")
	return command
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string) bool {
	switch os.Getenv(key) {
	case "1", "true", "TRUE", "yes":
		return true
	default:
		return false
	}
}

// runnerClient builds the proof-signing client, optionally skipping the
// server certificate check for self-signed servers.
func runnerClient(serverURL string, key ed25519.PrivateKey, runnerID string, insecureTLS bool) (*runner.Client, error) {
	if !insecureTLS {
		return runner.NewClient(serverURL, key, runnerID)
	}
	return runner.NewClientWithTLS(serverURL, key, runnerID, &tls.Config{InsecureSkipVerify: true}) //nolint:gosec — opt-in, warned in the flag help
}
