// Package runner implements the argo-runner binary: enrolment, the claim
// loop and the Docker executor that runs workflow steps on a remote host.
package runner

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// CredentialsFile is the name of the credentials file inside the credentials
// directory.
const CredentialsFile = "runner-credentials.json"

// Credentials are the runner's identity, stored 0600 under a dedicated user.
type Credentials struct {
	RunnerID   string `json:"runnerID"`
	Pool       string `json:"pool"`
	PrivateKey []byte `json:"privateKey"`
	// ServerURL is the argo-server base URL the runner enrolled against.
	ServerURL string `json:"serverURL"`
}

// Key returns the Ed25519 private key.
func (c *Credentials) Key() (ed25519.PrivateKey, error) {
	if len(c.PrivateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("private key must be %d bytes, got %d", ed25519.PrivateKeySize, len(c.PrivateKey))
	}
	return ed25519.PrivateKey(c.PrivateKey), nil
}

// SaveCredentials writes the credentials file with 0600 permissions.
func SaveCredentials(dir string, c *Credentials) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating credentials directory: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshalling credentials: %w", err)
	}
	path := filepath.Join(dir, CredentialsFile)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("writing credentials: %w", err)
	}
	return nil
}

// LoadCredentials reads the credentials file.
func LoadCredentials(dir string) (*Credentials, error) {
	data, err := os.ReadFile(filepath.Join(dir, CredentialsFile))
	if err != nil {
		return nil, fmt.Errorf("reading credentials: %w", err)
	}
	c := &Credentials{}
	if err := json.Unmarshal(data, c); err != nil {
		return nil, fmt.Errorf("parsing credentials: %w", err)
	}
	if c.RunnerID == "" || c.Pool == "" || c.ServerURL == "" {
		return nil, fmt.Errorf("credentials are incomplete; re-enrol the runner")
	}
	if _, err := c.Key(); err != nil {
		return nil, err
	}
	return c, nil
}
