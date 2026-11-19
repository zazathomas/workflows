package runner

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// LoopConfig configures the claim loop.
type LoopConfig struct {
	Client        *Client
	Executor      *Executor
	Log           logging.Logger
	Once          bool // run one job, then exit
	HeartbeatGap  time.Duration
	ClaimInterval time.Duration
}

// Loop claims and executes jobs until the context is cancelled, the runner is
// told to stop (revoked, quarantined), or --once completed a job.
type Loop struct {
	cfg            LoopConfig
	heartbeatEvery time.Duration
}

func NewLoop(cfg LoopConfig) *Loop {
	heartbeat := cfg.HeartbeatGap
	if heartbeat <= 0 {
		heartbeat = api.DefaultHeartbeatInterval
	}
	if cfg.Executor != nil && cfg.Client != nil {
		cfg.Executor.WithTransfers(cfg.Client)
	}
	return &Loop{cfg: cfg, heartbeatEvery: heartbeat}
}

// Run blocks until the runner should stop. It returns nil on graceful drain.
func (l *Loop) Run(ctx context.Context) error {
	log := l.cfg.Log
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		resp, err := l.cfg.Client.Claim(ctx)
		if err != nil {
			if permanent(err) {
				log.WithError(err).Error(ctx, "stopping runner: claim rejected")
				return err
			}
			log.WithError(err).Warn(ctx, "claim failed; backing off")
			sleep(ctx, backoff+jitter(backoff))
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second

		if resp.Job == nil {
			// No job during the long-poll window: poll again shortly.
			sleep(ctx, l.pollGap())
			continue
		}

		job := resp.Job
		if err := l.runJob(ctx, job); err != nil {
			if permanent(err) {
				log.WithError(err).Error(ctx, "stopping runner: rejected by server")
				return err
			}
			// A result that could not be submitted must surface: the job
			// ran, so the runner cannot pretend it did not.
			log.WithError(err).Warn(ctx, "job result could not be submitted")
			return err
		}
		if l.cfg.Once {
			log.Info(ctx, "--once: exiting after one job")
			return nil
		}
	}
}

// runJob executes a job with heartbeats and submits its result.
func (l *Loop) runJob(ctx context.Context, job *api.JobSpec) error {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Heartbeat goroutine: stop the container when the server says stop.
	stop := make(chan struct{})
	go func() {
		defer close(stop)
		ticker := time.NewTicker(l.heartbeatEvery)
		defer ticker.Stop()
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
			}
			resp, err := l.cfg.Client.Heartbeat(jobCtx, job.ID, job.Token)
			if err != nil {
				if permanent(err) {
					l.cfg.Log.WithError(err).Warn(jobCtx, "heartbeat rejected; stopping job")
					cancel()
					return
				}
				continue // transient: retry on the next tick
			}
			if !resp.Continue {
				l.cfg.Log.WithField("reason", resp.Reason).Info(jobCtx, "server asked the runner to stop the job")
				cancel()
				return
			}
		}
	}()

	result := l.cfg.Executor.Execute(jobCtx, job)
	cancel()
	<-stop // the heartbeat goroutine has left the loop

	// Report the result even when the job was cancelled: a result beats a
	// lease expiry, and the server ignores results for dead leases.
	reportCtx, reportCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer reportCancel()
	return l.cfg.Client.Result(reportCtx, job.ID, job.Token, result)
}

func (l *Loop) pollGap() time.Duration {
	if l.cfg.ClaimInterval > 0 {
		return l.cfg.ClaimInterval
	}
	return time.Second
}

// permanent reports whether an error should stop the runner.
func permanent(err error) bool {
	var httpErr *HTTPError
	if as := errors.As(err, &httpErr); as {
		return httpErr.Permanent()
	}
	return false
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// jitter returns up to 20% of d.
func jitter(d time.Duration) time.Duration {
	return time.Duration(rand.Int64N(int64(d/5) + 1))
}
