package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// ProofVersion prefixes every canonical proof string. It keeps proof
// signatures from ever being confused with, or cross-used as, other JWSs.
const ProofVersion = "argo-runner-proof-v1"

// ProofCanonical builds the string that is signed (and verified). All six
// components are pinned: method, path, query, SHA-256 of the request body,
// the timestamp, and the nonce. A proof from one request can never verify
// another (including one with a different query string, which is where the
// artifact endpoints carry the job token and artifact name).
func ProofCanonical(method, path, query, bodyHash, timestamp, nonce string) string {
	return strings.Join([]string{ProofVersion, method, path, query, bodyHash, timestamp, nonce}, "\n")
}

// BodyHash is the SHA-256 of the request body, lowercase hex.
func BodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// NewProofTimestamp returns the canonical (RFC3339) form of t.
func NewProofTimestamp(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// ParseProofTimestamp parses a canonical timestamp.
func ParseProofTimestamp(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid proof timestamp %q: %w", s, err)
	}
	return t, nil
}

// EncodePublicKey encodes an Ed25519 public key as base64 (std).
func EncodePublicKey(k ed25519.PublicKey) string {
	return base64.StdEncoding.EncodeToString(k)
}

// DecodePublicKey decodes a base64 (std) Ed25519 public key.
func DecodePublicKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("public key is not valid base64: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must be %d bytes, got %d", ed25519.PublicKeySize, len(b))
	}
	return ed25519.PublicKey(b), nil
}

// RandomHex returns n random bytes hex encoded. It panics on failure, which
// only happens if the system CSPRNG is broken.
func RandomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// HashToken returns the lowercase hex SHA-256 of a token. Tokens (join tokens,
// job tokens) are only ever stored and compared in this form.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SignProof signs the canonical proof string with the runner's Ed25519
// private key and returns the compact JWS serialization for the proof header.
func SignProof(privateKey ed25519.PrivateKey, canonical string) (string, error) {
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: privateKey}, nil)
	if err != nil {
		return "", fmt.Errorf("creating proof signer: %w", err)
	}
	jws, err := signer.Sign([]byte(canonical))
	if err != nil {
		return "", fmt.Errorf("signing proof: %w", err)
	}
	return jws.CompactSerialize()
}

// VerifyProofJWS parses a compact JWS proof, verifies it with the given public
// key, and returns the signed payload. Callers must compare the payload
// against the canonical string they built from the request.
func VerifyProofJWS(proof string, publicKey ed25519.PublicKey) ([]byte, error) {
	jws, err := jose.ParseSigned(proof, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil {
		return nil, fmt.Errorf("parsing proof: %w", err)
	}
	payload, err := jws.Verify(publicKey)
	if err != nil {
		return nil, fmt.Errorf("verifying proof signature: %w", err)
	}
	return payload, nil
}

// NewProofNonce returns a fresh single-use nonce for a request proof.
func NewProofNonce() string {
	return RandomHex(16)
}

// BuildProof builds the proof header value for a request: the compact JWS
// over the canonical string, followed by the timestamp and nonce again for
// debuggability. The signature covers all three via the canonical string.
func BuildProof(privateKey ed25519.PrivateKey, method, path, query string, body []byte, now time.Time, nonce string) (string, error) {
	timestamp := NewProofTimestamp(now)
	canonical := ProofCanonical(method, path, query, BodyHash(body), timestamp, nonce)
	jws, err := SignProof(privateKey, canonical)
	if err != nil {
		return "", err
	}
	return jws + " " + timestamp + " " + nonce, nil
}

// SpecSignatureVersion prefixes the canonical string a job-spec signature
// covers. It keeps job-spec signatures from ever being confused with, or
// cross-used as, request proofs (which carry their own version).
const SpecSignatureVersion = "argo-runner-job-spec-v1"

// SignJobSpec signs a job spec for a runner whose policy pins signing keys.
// The key is held by an operator-run signer such as `argo-runner gate`, never
// by argo-server. It signs the spec it is given: that is transport integrity
// for a runner that cannot verify its server, not a defence against a
// compromised control plane (which is inside the trust boundary for v1).
// The signature covers the canonical form of the spec with the signature
// field cleared, so it binds every field the runner would act on.
func SignJobSpec(privateKey ed25519.PrivateKey, spec *JobSpec) (string, error) {
	canonical, err := specSignatureCanonical(spec)
	if err != nil {
		return "", err
	}
	return SignProof(privateKey, SpecSignatureVersion+"\n"+canonical)
}

// VerifyJobSpecSignature checks a job-spec signature against one of the
// pinned public keys. An empty signature never verifies.
func VerifyJobSpecSignature(spec *JobSpec, signature string, publicKeys []ed25519.PublicKey) bool {
	if signature == "" || len(publicKeys) == 0 {
		return false
	}
	canonical, err := specSignatureCanonical(spec)
	if err != nil {
		return false
	}
	payload := SpecSignatureVersion + "\n" + canonical
	for _, key := range publicKeys {
		if verified, err := VerifyProofJWS(signature, key); err == nil && string(verified) == payload {
			return true
		}
	}
	return false
}

// specSignatureCanonical renders the spec with the signature field cleared:
// signing and verification must marshal exactly the same bytes.
func specSignatureCanonical(spec *JobSpec) (string, error) {
	copySpec := *spec
	copySpec.SpecSignature = ""
	raw, err := json.Marshal(&copySpec)
	if err != nil {
		return "", fmt.Errorf("marshalling job spec for signing: %w", err)
	}
	return string(raw), nil
}
