package broker

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

const (
	leaseSeconds     = api.LeaseDurationSeconds
	interestSeconds  = 120
	maxQueued        = 512
	maxInlineBytes   = 256 << 10
	maxArtifactBytes = 256 << 10
)

var (
	errConflict = errors.New("job state changed or request conflicts with existing state")
	errCapacity = errors.New("queue capacity reached")
)

const schema = `
CREATE TABLE IF NOT EXISTS runner_broker_tokens (
  hash text PRIMARY KEY, scope text NOT NULL, expires timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_broker_workers (
  id text PRIMARY KEY, scope text NOT NULL, key bytea UNIQUE NOT NULL,
  labels text[] NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS runner_broker_proofs (
  worker text REFERENCES runner_broker_workers(id) ON DELETE CASCADE,
  nonce text NOT NULL, expires timestamptz NOT NULL, PRIMARY KEY(worker, nonce)
);
CREATE INDEX IF NOT EXISTS runner_broker_proofs_expiry ON runner_broker_proofs(expires);
CREATE TABLE IF NOT EXISTS runner_broker_jobs (
  id text PRIMARY KEY, scope text NOT NULL, request jsonb NOT NULL,
  fingerprint text NOT NULL, capabilities text[] NOT NULL,
  created timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline timestamptz NOT NULL, interest timestamptz NOT NULL,
  attempt int NOT NULL DEFAULT 0, worker text NOT NULL DEFAULT '',
  token text NOT NULL DEFAULT '', lease timestamptz, result jsonb,
  finished timestamptz, logs bytea NOT NULL DEFAULT ''::bytea
);
CREATE INDEX IF NOT EXISTS runner_broker_queue ON runner_broker_jobs(scope, created) WHERE result IS NULL;
CREATE INDEX IF NOT EXISTS runner_broker_finished ON runner_broker_jobs(scope, finished) WHERE finished IS NOT NULL;
CREATE TABLE IF NOT EXISTS runner_broker_outputs (
  job text REFERENCES runner_broker_jobs(id) ON DELETE CASCADE,
  attempt int NOT NULL, name text NOT NULL, content bytea NOT NULL,
  PRIMARY KEY(job, attempt, name)
);`

// Migrate initializes the broker tables in a dedicated PostgreSQL database.
func Migrate(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(1771685703)`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	return tx.Commit()
}

type submission struct {
	Workflow       api.WorkflowRef   `json:"workflow"`
	Node           string            `json:"node"`
	Retry          int               `json:"retry"`
	Task           api.JobTemplate   `json:"task"`
	Capabilities   []string          `json:"capabilities"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	Inputs         map[string][]byte `json:"inputs,omitempty"`
}

type outcome struct {
	Result    *api.Result       `json:"result,omitempty"`
	Artifacts map[string][]byte `json:"artifacts,omitempty"`
}

func (s *Server) lock(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 1771685703))`, s.scope)
	return err
}

func (s *Server) expire(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `UPDATE runner_broker_jobs SET
		result=jsonb_build_object('phase','Error','message',CASE WHEN deadline<=clock_timestamp() THEN 'remote deadline expired'
		WHEN interest<=clock_timestamp() THEN 'Argo stopped polling the remote step' ELSE 'runner attempts exhausted' END),
		finished=clock_timestamp()
		WHERE scope=$1 AND result IS NULL AND (deadline<=clock_timestamp() OR interest<=clock_timestamp() OR (attempt >= $2 AND lease<=clock_timestamp()))`, s.scope, api.MaxAttempts)
	return err
}

func (s *Server) submit(ctx context.Context, in submission) (outcome, error) {
	id := api.HashToken(fmt.Sprintf("%s\x00%s\x00%s\x00%d", s.scope, in.Workflow.UID, in.Node, in.Retry))
	raw, err := json.Marshal(in)
	if err != nil {
		return outcome{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return outcome{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.lock(ctx, tx); err != nil {
		return outcome{}, err
	}
	if err := s.expire(ctx, tx); err != nil {
		return outcome{}, err
	}
	var result []byte
	var fingerprint string
	var attempt int
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,result,attempt FROM runner_broker_jobs WHERE id=$1 AND scope=$2 FOR UPDATE`, id, s.scope).Scan(&fingerprint, &result, &attempt)
	hash := api.BodyHash(raw)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM runner_broker_jobs WHERE scope=$1 AND result IS NULL`, s.scope).Scan(&count); err != nil {
			return outcome{}, err
		}
		if count >= maxQueued {
			return outcome{}, errCapacity
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO runner_broker_jobs(id,scope,request,fingerprint,capabilities,deadline,interest)
		VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6),clock_timestamp()+make_interval(secs=>$7))`, id, s.scope, string(raw), hash, textArray(in.Capabilities), in.TimeoutSeconds, interestSeconds)
	case err == nil && fingerprint != hash:
		return outcome{}, errConflict
	case err == nil && len(result) == 0:
		_, err = tx.ExecContext(ctx, `UPDATE runner_broker_jobs SET interest=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1`, id, interestSeconds)
	}
	if err != nil {
		return outcome{}, err
	}
	var out outcome
	if len(result) > 0 {
		if err := json.Unmarshal(result, &out.Result); err != nil {
			return outcome{}, err
		}
		if out.Result.Phase == api.PhaseSucceeded {
			rows, err := tx.QueryContext(ctx, `SELECT name,content FROM runner_broker_outputs WHERE job=$1 AND attempt=$2`, id, attempt)
			if err != nil {
				return outcome{}, err
			}
			defer func() { _ = rows.Close() }()
			out.Artifacts = map[string][]byte{}
			for rows.Next() {
				var name string
				var data []byte
				if err := rows.Scan(&name, &data); err != nil {
					return outcome{}, err
				}
				out.Artifacts[name] = data
			}
			if err := rows.Err(); err != nil {
				return outcome{}, err
			}
		}
	}
	return out, tx.Commit()
}

func (s *Server) claim(ctx context.Context, worker string) (*api.JobSpec, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.lock(ctx, tx); err != nil {
		return nil, err
	}
	var allowed bool
	if err := tx.QueryRowContext(ctx, `SELECT active FROM runner_broker_workers WHERE id=$1 AND scope=$2 FOR SHARE`, worker, s.scope).Scan(&allowed); err != nil {
		return nil, err
	}
	if !allowed {
		return nil, errProof
	}
	var count, owned int
	if err := tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER(WHERE worker=$2) FROM runner_broker_jobs WHERE scope=$1 AND result IS NULL AND lease>clock_timestamp()`, s.scope, worker).Scan(&count, &owned); err != nil {
		return nil, err
	}
	if count >= s.concurrency || owned > 0 {
		return nil, tx.Commit()
	}
	var job api.JobSpec
	var raw []byte
	job.Token = api.RandomHex(32)
	err = tx.QueryRowContext(ctx, `UPDATE runner_broker_jobs SET attempt=attempt+1, worker=$2,token=$3,lease=LEAST(deadline,clock_timestamp()+make_interval(secs=>$4)),logs=''::bytea
	WHERE id=(SELECT j.id FROM runner_broker_jobs j JOIN runner_broker_workers w ON w.id=$2 AND w.active
	WHERE j.scope=$1 AND j.result IS NULL AND j.attempt<$5 AND j.deadline>clock_timestamp() AND j.interest>clock_timestamp()
	AND (j.lease IS NULL OR j.lease<=clock_timestamp()) AND j.capabilities <@ w.labels
	ORDER BY j.created,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
	RETURNING id,attempt,deadline,request`, s.scope, worker, api.HashToken(job.Token), leaseSeconds, api.MaxAttempts).Scan(&job.ID, &job.Attempt, &job.Deadline, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	var in submission
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	job.Workflow, job.NodeID, job.Task, job.RunnerID, job.Pool = in.Workflow, in.Node, in.Task, worker, s.pool
	if _, err := tx.ExecContext(ctx, `DELETE FROM runner_broker_outputs WHERE job=$1 AND attempt<$2`, job.ID, job.Attempt); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &job, nil
}

const live = `scope=$1 AND id=$2 AND worker=$3 AND token=$4 AND result IS NULL AND lease>clock_timestamp()
AND deadline>clock_timestamp() AND interest>clock_timestamp()
AND EXISTS (SELECT 1 FROM runner_broker_workers WHERE id=$3 AND scope=$1 AND active)`

func (s *Server) heartbeat(ctx context.Context, worker string, in api.HeartbeatRequest) (bool, error) {
	r, err := s.db.ExecContext(ctx, `UPDATE runner_broker_jobs SET lease=LEAST(deadline,clock_timestamp()+make_interval(secs=>$5)) WHERE `+live, s.scope, in.JobID, worker, api.HashToken(in.Token), leaseSeconds)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Server) complete(ctx context.Context, worker string, in api.ResultRequest) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	args := []any{s.scope, in.JobID, worker, api.HashToken(in.Token)}
	var raw, old []byte
	var attempt int
	var fresh bool
	err = tx.QueryRowContext(ctx, `SELECT request,result,attempt,(lease>clock_timestamp() AND interest>clock_timestamp() AND deadline>clock_timestamp()) FROM runner_broker_jobs
	WHERE scope=$1 AND id=$2 AND worker=$3 AND token=$4 AND EXISTS (SELECT 1 FROM runner_broker_workers WHERE id=$3 AND active) FOR UPDATE`, args...).Scan(&raw, &old, &attempt, &fresh)
	if errors.Is(err, sql.ErrNoRows) {
		return errConflict
	}
	if err != nil {
		return err
	}
	result, err := json.Marshal(in.Result)
	if err != nil {
		return err
	}
	if len(old) > 0 {
		var previous api.Result
		if err := json.Unmarshal(old, &previous); err != nil {
			return err
		}
		canonical, err := json.Marshal(previous)
		if err != nil {
			return err
		}
		if bytes.Equal(canonical, result) {
			return tx.Commit()
		}
		return errConflict
	}
	if !fresh {
		return errConflict
	}
	var request submission
	if err := json.Unmarshal(raw, &request); err != nil {
		return err
	}
	declared := map[string]bool{}
	for _, p := range request.Task.Outputs.Parameters {
		declared[p.Name] = true
	}
	for _, p := range in.Result.OutputParameters {
		if !declared[p.Name] {
			return errConflict
		}
		delete(declared, p.Name)
	}
	if in.Result.Phase == api.PhaseSucceeded {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM runner_broker_outputs WHERE job=$1 AND attempt=$2`, in.JobID, attempt).Scan(&count); err != nil {
			return err
		}
		if len(declared) > 0 || count != len(request.Task.Outputs.Artifacts) {
			return errConflict
		}
	}
	r, err := tx.ExecContext(ctx, `UPDATE runner_broker_jobs SET result=$5,finished=clock_timestamp() WHERE `+live, append(args, string(result))...)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errConflict
	}
	return tx.Commit()
}
