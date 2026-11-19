package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

var errGateProjectionPending = errors.New("approval projection is not ready")

func gateCount(wf *wfv1.Workflow) int64 {
	if wf.Status.Phase != wfv1.WorkflowRunning {
		return 0
	}
	if wf.Status.CompressedNodes != "" || wf.Status.IsOffloadNodeStatus() {
		return -1
	}
	var count int64
	for _, node := range wf.Status.Nodes {
		if node.IsActiveSuspendNode() && !node.StartedAt.IsZero() {
			count++
		}
	}
	return count
}

// CountApprovalGates returns an exact count for one cache snapshot, or an
// error while the first list or any relevant packed node status is pending.
func (s *SQLiteStore) CountApprovalGates(ctx context.Context, namespace string) (int64, error) {
	s.mtx.Lock()
	defer s.mtx.Unlock()
	if !s.synced || ctx.Err() != nil {
		return 0, errGateProjectionPending
	}
	query := `select coalesce(sum(gates), 0), coalesce(min(gates), 0) from argo_workflows where gates != 0`
	var args []any
	if namespace != "" {
		query += " and namespace = ?"
		args = append(args, namespace)
	}
	var count int64
	err := sqlitex.Execute(s.conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		if stmt.ColumnInt64(1) < 0 {
			return errGateProjectionPending
		}
		count = stmt.ColumnInt64(0)
		return nil
	}})
	return count, err
}

func (s *SQLiteStore) ResolvePackedGates(ctx context.Context, hydrate hydrator.Interface) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	cursor := ""
	for ctx.Err() == nil {
		next, err := s.resolvePackedBatch(ctx, hydrate, cursor)
		if err != nil && ctx.Err() == nil {
			logging.RequireLoggerFromContext(ctx).WithError(err).Warn(ctx, "approval gate projection failed")
		}
		cursor = next
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *SQLiteStore) resolvePackedBatch(ctx context.Context, hydrate hydrator.Interface, cursor string) (string, error) {
	var rows []wfv1.Workflow
	s.mtx.Lock()
	err := sqlitex.Execute(s.conn, `select workflow from argo_workflows where gates = -1 and uid > ? order by uid limit 16`, &sqlitex.ExecOptions{
		Args: []any{cursor}, ResultFunc: func(stmt *sqlite.Stmt) error {
			var wf wfv1.Workflow
			if err := json.Unmarshal([]byte(stmt.ColumnText(0)), &wf); err != nil {
				return err
			}
			rows = append(rows, wf)
			return nil
		},
	})
	s.mtx.Unlock()
	if err != nil {
		return "", err
	}
	var failed error
	for i := range rows {
		if ctx.Err() != nil {
			break
		}
		wf := &rows[i]
		cursor = string(wf.UID)
		if err := hydrate.Hydrate(ctx, wf); err != nil {
			failed = fmt.Errorf("hydrate approval candidate: %w", err)
			continue
		}
		// A watch update or relist may have changed the workflow while hydrating.
		s.mtx.Lock()
		err := sqlitex.Execute(s.conn, `update argo_workflows set gates = ? where uid = ? and resourceversion = ? and gates = -1`, &sqlitex.ExecOptions{
			Args: []any{gateCount(wf), string(wf.UID), wf.ResourceVersion},
		})
		s.mtx.Unlock()
		if err != nil {
			failed = err
		}
	}
	if len(rows) < 16 {
		cursor = ""
	}
	return cursor, failed
}
