package broker

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lib/pq"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

const SubmitPath = "/v1/plugin/submit"
const maxRequest = 2 << 20

var pgArray = pq.Array

type Config struct {
	Namespace   string
	Pool        string
	PluginToken string
	Concurrency int
}

type Server struct {
	db                                  *sql.DB
	scope, namespace, pool, pluginToken string
	concurrency                         int
	slots                               chan struct{}
	claimSlots                          chan struct{}
}

func NewServer(db *sql.DB, cfg Config) (*Server, error) {
	if db == nil || len(validation.IsDNS1123Label(cfg.Namespace)) != 0 || len(validation.IsDNS1123Label(cfg.Pool)) != 0 || !validCredential(cfg.PluginToken) || cfg.Concurrency < 1 || cfg.Concurrency > 256 {
		return nil, errors.New("broker requires a database, DNS-label namespace and pool, random plugin token and concurrency between 1 and 256")
	}
	return &Server{db: db, scope: cfg.Namespace + "/" + cfg.Pool, namespace: cfg.Namespace, pool: cfg.Pool, pluginToken: cfg.PluginToken, concurrency: cfg.Concurrency, slots: make(chan struct{}, 128), claimSlots: make(chan struct{}, 80)}, nil
}

func validCredential(token string) bool {
	return len(token) >= 32 && len(token) <= 128 && !strings.ContainsAny(token, " \t\r\n\x00")
}

// Mint provisions a single-use token for this broker's pool.
func (s *Server) Mint(ctx context.Context, ttl time.Duration) (string, error) {
	if ttl < time.Second || ttl > time.Hour {
		return "", errors.New("join token TTL must be between one second and one hour")
	}
	token := "ajt_" + api.RandomHex(32)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.lock(ctx, tx); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM runner_broker_tokens WHERE scope=$1 AND expires<=clock_timestamp()`, s.scope); err != nil {
		return "", err
	}
	var outstanding int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM runner_broker_tokens WHERE scope=$1`, s.scope).Scan(&outstanding); err != nil {
		return "", err
	}
	if outstanding >= 256 {
		return "", errCapacity
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO runner_broker_tokens(hash,scope,expires) VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3))`, api.HashToken(token), s.scope, ttl.Seconds()); err != nil {
		return "", err
	}
	return token, tx.Commit()
}

func (s *Server) Revoke(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE runner_broker_workers SET active=false WHERE id=$1 AND scope=$2`, id, s.scope)
	return err
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		http.Error(w, "broker busy", 429)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.URL.Path == SubmitPath {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.pluginToken)) != 1 {
			http.Error(w, "forbidden", 403)
			return
		}
		var in submission
		if !decode(w, r, &in) || s.validate(in) != nil {
			http.Error(w, "invalid or unsupported remote step", 400)
			return
		}
		out, err := s.submit(ctx, in)
		if err != nil {
			writeError(w, err)
			return
		}
		reply(w, 200, out)
		return
	}
	endpoint, ok := strings.CutPrefix(r.URL.Path, api.APIPathPrefix)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if (endpoint == api.ArtifactInputPath && r.Method != http.MethodGet) || (endpoint != api.ArtifactInputPath && r.Method != http.MethodPost) {
		http.Error(w, "method not allowed", 405)
		return
	}
	if endpoint == "/enrol" {
		s.enrol(w, r)
		return
	}
	worker, raw, err := s.authenticate(w, r)
	if err != nil {
		writeError(w, err)
		return
	}
	switch endpoint {
	case "/claim":
		// Reserve capacity for heartbeats, results and plugin RPCs.
		select {
		case s.claimSlots <- struct{}{}:
			defer func() { <-s.claimSlots }()
		default:
			writeError(w, errCapacity)
			return
		}
		// Poll briefly so idle hosts don't generate database traffic every second.
		for i := 0; i < 4; i++ {
			job, err := s.claim(ctx, worker)
			if err != nil {
				writeError(w, err)
				return
			}
			if job != nil {
				reply(w, 200, api.ClaimResponse{Job: job})
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
		}
		reply(w, 200, api.ClaimResponse{})
	case "/heartbeat":
		var in api.HeartbeatRequest
		if json.Unmarshal(raw, &in) != nil || !validJobCredential(in.JobID, in.Token) {
			http.Error(w, "invalid heartbeat", 400)
			return
		}
		active, err := s.heartbeat(ctx, worker, in)
		if err != nil {
			writeError(w, err)
			return
		}
		reply(w, 200, api.HeartbeatResponse{Continue: active})
	case "/result":
		var in api.ResultRequest
		if json.Unmarshal(raw, &in) != nil || !validJobCredential(in.JobID, in.Token) || in.Result.Validate() != nil {
			http.Error(w, "invalid result", 400)
			return
		}
		if err := s.complete(ctx, worker, in); err != nil {
			// A stale completion is discarded. A cancelled attempt must not stop the worker's claim loop.
			if !errors.Is(err, errConflict) {
				writeError(w, err)
				return
			}
		}
		w.WriteHeader(204)
	case "/rotate":
		var in api.RotateRequest
		if json.Unmarshal(raw, &in) != nil {
			http.Error(w, "invalid rotation", 400)
			return
		}
		key, err := api.DecodePublicKey(in.PublicKey)
		if err != nil {
			http.Error(w, "invalid key", 400)
			return
		}
		if _, err = s.db.ExecContext(ctx, `UPDATE runner_broker_workers SET key=$3 WHERE id=$1 AND scope=$2 AND active`, worker, s.scope, []byte(key)); err != nil {
			writeError(w, err)
			return
		}
		w.WriteHeader(204)
	case api.LogsEndpoint, api.ArtifactInputPath, api.ArtifactOutputPath:
		s.transfer(w, r, worker, endpoint, raw)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) validate(in submission) error {
	n := in.Workflow
	if n.Namespace != s.namespace || len(validation.IsDNS1123Subdomain(n.Name)) != 0 || len(n.UID) == 0 || len(n.UID) > 128 || strings.ContainsRune(n.UID, 0) || len(in.Node) == 0 || len(in.Node) > 1024 || strings.ContainsRune(in.Node, 0) || (in.Node != n.Name && !strings.HasPrefix(in.Node, n.Name+".") && !strings.HasPrefix(in.Node, n.Name+"[")) || in.Retry < 0 || in.Retry > 1000 || in.TimeoutSeconds < 1 || in.TimeoutSeconds > 3600 || !api.IsDigestPinned(in.Task.Image) {
		return errConflict
	}
	spec := api.RunnerTemplate{Pool: s.pool, Image: in.Task.Image, Command: in.Task.Command, Args: in.Task.Args, Env: in.Task.Env, Resources: in.Task.Resources, RunsOn: in.Capabilities}
	if err := spec.Validate(); err != nil {
		return err
	}
	for _, v := range in.Task.Env {
		if v.SecretKeyRef != nil {
			return errConflict
		}
	}
	if len(in.Task.Inputs.Artifacts)+len(in.Task.Outputs.Artifacts) > 4 || len(in.Task.Inputs.Artifacts) != len(in.Inputs) {
		return errConflict
	}
	var total int
	for _, list := range [][]api.JobArtifact{in.Task.Inputs.Artifacts, in.Task.Outputs.Artifacts} {
		seen := map[string]bool{}
		for _, a := range list {
			if seen[a.Name] || len(validation.IsDNS1123Label(a.Name)) != 0 || api.ValidateArtifactPath(a) != nil {
				return errConflict
			}
			seen[a.Name] = true
		}
	}
	for _, a := range in.Task.Inputs.Artifacts {
		data, ok := in.Inputs[a.Name]
		if !ok {
			return errConflict
		}
		total += len(data)
	}
	if total > maxInlineBytes {
		return errConflict
	}
	seen := map[string]bool{}
	for _, p := range in.Task.Outputs.Parameters {
		if seen[p.Name] || api.ValidateOutputPath(p) != nil {
			return errConflict
		}
		seen[p.Name] = true
	}
	return nil
}

func (s *Server) enrol(w http.ResponseWriter, r *http.Request) {
	var in api.EnrolRequest
	if !decode(w, r, &in) || !validCredential(in.JoinToken) || api.ValidateRunnerLabels(in.Labels) != nil || in.Attestation != nil {
		http.Error(w, "invalid enrollment", 400)
		return
	}
	key, err := api.DecodePublicKey(in.PublicKey)
	if err != nil {
		http.Error(w, "invalid enrollment", 400)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	n, err := tx.ExecContext(r.Context(), `DELETE FROM runner_broker_tokens WHERE hash=$1 AND scope=$2 AND expires>clock_timestamp()`, api.HashToken(in.JoinToken), s.scope)
	if err != nil {
		writeError(w, err)
		return
	}
	total, err := n.RowsAffected()
	if err != nil {
		writeError(w, err)
		return
	}
	if total != 1 {
		http.Error(w, "invalid enrollment", 401)
		return
	}
	id := "r-" + api.RandomHex(16)
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO runner_broker_workers(id,scope,key,labels) VALUES($1,$2,$3,$4)`, id, s.scope, []byte(key), textArray(in.Labels)); err != nil {
		writeError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	reply(w, 200, api.EnrolResponse{RunnerID: id, Pool: s.pool, HeartbeatInterval: api.DefaultHeartbeatInterval.String()})
}

var errProof = errors.New("invalid runner proof")

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (string, []byte, error) {
	id := r.Header.Get(api.RunnerIDHeader)
	proof := r.Header.Get(api.ProofHeader)
	if len(id) != 34 || !strings.HasPrefix(id, "r-") || len(proof) > 4096 {
		return "", nil, errProof
	}
	parts := strings.Fields(proof)
	if len(parts) != 3 || len(parts[2]) > 128 {
		return "", nil, errProof
	}
	stamp, err := api.ParseProofTimestamp(parts[1])
	if err != nil || time.Since(stamp) > api.ProofTimestampWindow || time.Until(stamp) > api.ProofTimestampWindow {
		return "", nil, errProof
	}
	var key []byte
	err = s.db.QueryRowContext(r.Context(), `SELECT key FROM runner_broker_workers WHERE id=$1 AND scope=$2 AND active`, id, s.scope).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && len(key) != ed25519.PublicKeySize) {
		return "", nil, errProof
	}
	if err != nil {
		return "", nil, err
	}
	payload, err := api.VerifyProofJWS(parts[0], ed25519.PublicKey(key))
	if err != nil {
		return "", nil, errProof
	}
	limit := int64(maxRequest)
	if r.URL.Path == api.APIPathPrefix+api.ArtifactOutputPath {
		limit = maxArtifactBytes
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return "", nil, errProof
	}
	digest := api.BodyHash(raw)
	if r.URL.Path == api.APIPathPrefix+api.ArtifactOutputPath && r.Header.Get(api.BodyDigestHeader) != digest {
		return "", nil, errProof
	}
	if !bytes.Equal(payload, []byte(api.ProofCanonical(r.Method, r.URL.Path, r.URL.RawQuery, digest, parts[1], parts[2]))) {
		return "", nil, errProof
	}
	result, err := s.db.ExecContext(r.Context(), `INSERT INTO runner_broker_proofs(worker,nonce,expires) SELECT id,$2,$3 FROM runner_broker_workers WHERE id=$1 AND key=$4 AND active ON CONFLICT DO NOTHING`, id, parts[2], stamp.Add(api.ProofTimestampWindow+time.Minute), key)
	if err != nil {
		return "", nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return "", nil, err
	}
	if n != 1 {
		return "", nil, errProof
	}
	return id, raw, nil
}

func (s *Server) transfer(w http.ResponseWriter, r *http.Request, worker, endpoint string, raw []byte) {
	q := r.URL.Query()
	job, token, name := q.Get("job"), q.Get("token"), q.Get("name")
	if !validJobCredential(job, token) {
		http.Error(w, "invalid job credentials", 400)
		return
	}
	ctx := r.Context()
	args := []any{s.scope, job, worker, api.HashToken(token)}
	if endpoint == api.LogsEndpoint {
		var in api.LogChunkRequest
		const logLimit = 1 << 20
		if json.Unmarshal(raw, &in) != nil || in.Offset < 0 || in.Offset > logLimit || len(in.Data) > api.MaxLogChunkBytes || in.Offset+int64(len(in.Data)) > logLimit {
			http.Error(w, "invalid or oversized log chunk", 400)
			return
		}
		result, err := s.db.ExecContext(ctx, `UPDATE runner_broker_jobs SET logs=CASE WHEN octet_length(logs)=$5 THEN logs||$6 ELSE logs END WHERE `+live+` AND (octet_length(logs)=$5 OR substring(logs FROM ($5::int+1) FOR octet_length($6::bytea))=$6)`, append(args, int(in.Offset), in.Data)...)
		if err != nil {
			writeError(w, err)
			return
		}
		n, err := result.RowsAffected()
		if err != nil {
			writeError(w, err)
			return
		}
		if n != 1 {
			writeError(w, errConflict)
			return
		}
		w.WriteHeader(204)
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	var data []byte
	var attempt int
	err = tx.QueryRowContext(ctx, `SELECT request,attempt FROM runner_broker_jobs WHERE `+live+` FOR UPDATE`, args...).Scan(&data, &attempt)
	if errors.Is(err, sql.ErrNoRows) {
		err = errConflict
	}
	if err != nil {
		writeError(w, err)
		return
	}
	var in submission
	if err = json.Unmarshal(data, &in); err != nil {
		writeError(w, err)
		return
	}
	if endpoint == api.ArtifactInputPath {
		content, ok := in.Inputs[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		_, _ = w.Write(content)
		return
	}
	found := false
	for _, a := range in.Task.Outputs.Artifacts {
		found = found || a.Name == name
	}
	if !found {
		http.NotFound(w, r)
		return
	}
	if !utf8.Valid(raw) {
		http.Error(w, "only UTF-8 inline output artifacts are supported", 400)
		return
	}
	var saved []byte
	err = tx.QueryRowContext(ctx, `INSERT INTO runner_broker_outputs(job,attempt,name,content) VALUES($1,$2,$3,$4) ON CONFLICT(job,attempt,name) DO UPDATE SET content=runner_broker_outputs.content RETURNING content`, job, attempt, name, raw).Scan(&saved)
	if err != nil {
		writeError(w, err)
		return
	}
	if !bytes.Equal(saved, raw) {
		writeError(w, errConflict)
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(204)
}

func validJobCredential(id, token string) bool { return len(id) == 64 && len(token) == 64 }
func textArray(list []string) any {
	if list == nil {
		list = []string{}
	}
	return pgArray(list)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequest))
	d.DisallowUnknownFields()
	return d.Decode(v) == nil && d.Decode(new(any)) == io.EOF
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCapacity):
		http.Error(w, "broker capacity reached", 429)
	case errors.Is(err, errConflict):
		http.Error(w, "job state conflict", 409)
	case errors.Is(err, errProof):
		http.Error(w, "unauthorized runner", 401)
	default:
		http.Error(w, "broker temporarily unavailable", 503)
	}
}

// Maintain expires abandoned jobs and removes expired proof and join records.
func (s *Server) Maintain(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM runner_broker_proofs WHERE expires<=clock_timestamp()`); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM runner_broker_tokens WHERE scope=$1 AND expires<=clock_timestamp()`, s.scope); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err = s.expire(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}
