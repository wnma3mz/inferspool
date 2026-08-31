package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"sort"
	"sync"
	"time"
)

var ErrCanceled = errors.New("canceled by user")

type BatchContext struct {
	client    QueueAPI
	lease     time.Duration
	heartbeat time.Duration

	mu       sync.Mutex
	active   map[string]bool
	canceled map[string]bool
	lost     map[string]bool
	progress map[string]ProgressUpdate
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
}

func NewBatchContext(client QueueAPI, ids []string, lease, heartbeat time.Duration) *BatchContext {
	active := make(map[string]bool, len(ids))
	for _, id := range ids {
		active[id] = true
	}
	return &BatchContext{client: client, lease: lease, heartbeat: heartbeat, active: active,
		canceled: map[string]bool{}, lost: map[string]bool{}, progress: map[string]ProgressUpdate{},
		stop: make(chan struct{}), done: make(chan struct{})}
}

func (b *BatchContext) Start(ctx context.Context) { go b.run(ctx) }

func (b *BatchContext) Close() {
	b.once.Do(func() { close(b.stop) })
	select {
	case <-b.done:
	case <-time.After(b.heartbeat + 10*time.Second):
	}
}

func (b *BatchContext) Finish(id string) {
	b.mu.Lock()
	delete(b.active, id)
	delete(b.progress, id)
	b.mu.Unlock()
}

func (b *BatchContext) Check(id string, fraction *float64, message *string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.canceled[id] {
		return ErrCanceled
	}
	if b.lost[id] {
		return ErrLeaseLost
	}
	if fraction != nil || message != nil {
		b.progress[id] = ProgressUpdate{ID: id, Progress: fraction, Message: message}
	}
	return nil
}

func (b *BatchContext) run(ctx context.Context) {
	defer close(b.done)
	ticker := time.NewTicker(b.heartbeat)
	defer ticker.Stop()
	lastOK := time.Now()
	for {
		select {
		case <-b.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		b.mu.Lock()
		ids := make([]string, 0, len(b.active))
		for id := range b.active {
			ids = append(ids, id)
		}
		updates := make([]ProgressUpdate, 0, len(b.progress))
		for _, update := range b.progress {
			updates = append(updates, update)
		}
		b.progress = map[string]ProgressUpdate{}
		b.mu.Unlock()
		if len(ids) == 0 {
			continue
		}
		canceled, lost, err := b.client.Heartbeat(ctx, ids, int(b.lease/time.Second))
		if err != nil {
			log.Printf("batch heartbeat failed: %v", err)
			if errors.Is(err, ErrLeaseLost) || time.Since(lastOK) > b.lease {
				b.mu.Lock()
				for _, id := range ids {
					b.lost[id] = true
				}
				b.mu.Unlock()
				return
			}
		} else {
			lastOK = time.Now()
			b.mu.Lock()
			for id := range canceled {
				b.canceled[id] = true
			}
			for id := range lost {
				b.lost[id] = true
			}
			b.mu.Unlock()
			if len(canceled) > 0 {
				log.Printf("cancel requested for %d job(s)", len(canceled))
			}
			if len(lost) > 0 {
				log.Printf("lost the lease on %d job(s)", len(lost))
			}
		}
		if len(updates) > 0 {
			if err := b.client.Progress(ctx, updates); err != nil {
				log.Printf("progress update failed: %v", err)
			}
		}
	}
}

type Runner struct {
	cfg        Config
	client     QueueAPI
	registry   *ServiceRegistry
	supervisor *Supervisor
	handlers   map[string]Handler
	draining   chan struct{}
	drainOnce  sync.Once
	lastReport time.Time
}

func NewRunner(cfg Config, client QueueAPI, registry *ServiceRegistry, supervisor *Supervisor, handlers map[string]Handler) *Runner {
	return &Runner{cfg: cfg, client: client, registry: registry, supervisor: supervisor,
		handlers: handlers, draining: make(chan struct{})}
}

func (r *Runner) Shutdown() { r.drainOnce.Do(func() { close(r.draining) }) }

func (r *Runner) isDraining() bool {
	select {
	case <-r.draining:
		return true
	default:
		return false
	}
}

func (r *Runner) Run(ctx context.Context) {
	managed := []string{}
	if r.supervisor != nil {
		managed = r.supervisor.ManagedTypes()
	}
	log.Printf("worker up: services=%v handlers=%v on-demand=%v", r.registry.Types(), sortedKeys(r.handlers), managed)
	backoff := r.cfg.IdlePoll
	for !r.isDraining() && ctx.Err() == nil {
		healths := r.registry.CheckAll(ctx, false)
		r.maybeReport(ctx, healths)
		pending, err := r.client.PendingByType(ctx)
		if err != nil {
			log.Printf("queue unreachable: %v", err)
			r.sleep(min(backoff, 60*time.Second))
			backoff = min(backoff*2, 60*time.Second)
			continue
		}
		backoff = r.cfg.IdlePoll
		var queued []string
		for _, health := range healths {
			if r.handlers[health.Type] != nil && pending[health.Type] > 0 {
				queued = append(queued, health.Type)
			}
		}
		if len(queued) == 0 {
			if r.supervisor != nil {
				if stopped := r.supervisor.ReapIdle(); stopped != "" {
					r.registry.Invalidate(stopped)
				}
			}
			r.sleep(jitter(r.cfg.IdlePoll))
			continue
		}
		var live []string
		for _, jobType := range queued {
			if r.ready(ctx, jobType) {
				live = append(live, jobType)
			}
		}
		if len(live) == 0 {
			delay := r.registry.Backoff()
			if delay < r.cfg.IdlePoll {
				delay = r.cfg.IdlePoll
			}
			r.sleep(delay)
			continue
		}
		claimedAny := false
		for _, jobType := range live {
			if r.isDraining() {
				break
			}
			if !r.ready(ctx, jobType) {
				continue
			}
			limit := min(max(1, r.registry.Capacity(jobType)), pending[jobType])
			jobs, err := r.client.Claim(ctx, jobType, limit, int(r.cfg.Lease/time.Second))
			if err != nil {
				log.Printf("claim(%s) failed: %v", jobType, err)
				continue
			}
			if len(jobs) > 0 {
				claimedAny = true
				if r.supervisor != nil {
					r.supervisor.Touch(jobType)
				}
				r.runBatch(ctx, jobType, jobs)
			}
		}
		if !claimedAny {
			r.sleep(jitter(r.cfg.IdlePoll))
		}
	}
	if r.supervisor != nil {
		r.supervisor.StopAll()
	}
	r.reportOffline(context.Background())
	log.Print("drained, exiting")
}

func (r *Runner) ready(ctx context.Context, jobType string) bool {
	if r.supervisor == nil || !r.supervisor.Manages(jobType) {
		return r.registry.Check(ctx, jobType, false).Healthy
	}
	return r.supervisor.Ensure(jobType, func() bool { return r.registry.Check(ctx, jobType, true).Healthy })
}

func (r *Runner) maybeReport(ctx context.Context, healths []ServiceHealth) {
	if time.Since(r.lastReport) < r.cfg.ReportEvery {
		return
	}
	if err := r.client.ReportServices(ctx, healths); err != nil {
		log.Printf("service report failed: %v", err)
		return
	}
	r.lastReport = time.Now()
}

func (r *Runner) reportOffline(ctx context.Context) {
	healths := r.registry.CheckAll(ctx, false)
	for i := range healths {
		healths[i].Healthy = false
		healths[i].Detail = "worker stopped"
	}
	_ = r.client.ReportServices(ctx, healths)
}

func (r *Runner) sleep(duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-r.draining:
	}
}

type jobResult struct {
	job    Job
	result map[string]any
	err    error
}

func (r *Runner) runBatch(ctx context.Context, jobType string, jobs []Job) {
	ids := make([]string, len(jobs))
	for i, job := range jobs {
		ids[i] = job.ID
	}
	log.Printf("%s: claimed %d job(s)", jobType, len(jobs))
	started := time.Now()
	health := r.registry.Check(ctx, jobType, false)
	handler := r.handlers[jobType]
	batch := NewBatchContext(r.client, ids, r.cfg.Lease, r.cfg.Heartbeat)
	batch.Start(ctx)
	defer batch.Close()
	results := make(chan jobResult, len(jobs))
	for _, job := range jobs {
		go func(job Job) { result, err := handler(ctx, job, batch, health); results <- jobResult{job, result, err} }(job)
	}
	for range jobs {
		item := <-results
		r.settle(ctx, item, batch)
	}
	log.Printf("%s: batch of %d done in %.1fs", jobType, len(jobs), time.Since(started).Seconds())
}

func (r *Runner) settle(ctx context.Context, item jobResult, batch *BatchContext) {
	defer batch.Finish(item.job.ID)
	if item.err != nil {
		switch {
		case errors.Is(item.err, ErrLeaseLost):
			return
		case errors.Is(item.err, ErrCanceled):
			r.safeFail(ctx, item.job.ID, "canceled by user", true)
		default:
			var permanent *PermanentError
			if errors.As(item.err, &permanent) {
				r.safeFail(ctx, item.job.ID, permanent.Error(), false)
			} else {
				r.safeFail(ctx, item.job.ID, fmt.Sprintf("%T: %v", item.err, item.err), true)
			}
		}
		return
	}
	if err := batch.Check(item.job.ID, nil, nil); err != nil {
		if errors.Is(err, ErrCanceled) {
			r.safeFail(ctx, item.job.ID, "canceled by user", true)
		}
		return
	}
	r.reportDone(ctx, item.job.ID, item.result, batch)
}

var completionRetryDelays = []time.Duration{0, time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

func (r *Runner) reportDone(ctx context.Context, id string, result map[string]any, batch *BatchContext) {
	for _, delay := range completionRetryDelays {
		if delay > 0 {
			time.Sleep(delay)
		}
		if batch != nil {
			if err := batch.Check(id, nil, nil); err != nil {
				switch {
				case errors.Is(err, ErrCanceled):
					r.safeFail(ctx, id, "canceled by user", true)
				case errors.Is(err, ErrLeaseLost):
					log.Printf("job %.8s finished but lease was lost; result discarded", id)
				}
				return
			}
		}
		err := r.client.Complete(ctx, id, result)
		if err == nil {
			return
		}
		if errors.Is(err, ErrLeaseLost) {
			log.Printf("job %.8s finished but lease was lost; result discarded", id)
			return
		}
		log.Printf("job %.8s: complete failed, retrying: %v", id, err)
	}
	log.Printf("job %.8s: could not report completion; it will be retried after lease expiry", id)
}

func (r *Runner) safeFail(ctx context.Context, id, message string, retryable bool) {
	if err := r.client.Fail(ctx, id, message, retryable); err != nil && !errors.Is(err, ErrLeaseLost) {
		log.Printf("job %.8s: could not report failure: %v", id, err)
	}
}

func jitter(base time.Duration) time.Duration {
	return time.Duration(float64(base) * (.5 + rand.Float64()))
}
func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
