package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeQueue struct {
	mu             sync.Mutex
	heartbeats     int
	heartbeatIDs   [][]string
	canceled       map[string]bool
	lost           map[string]bool
	heartbeatErr   error
	progress       []ProgressUpdate
	completeErrors []error
	completes      int
	fails          []struct {
		retryable bool
		message   string
	}
}

func (f *fakeQueue) PendingByType(context.Context) (map[string]int, error) {
	return map[string]int{}, nil
}
func (f *fakeQueue) ReportServices(context.Context, []ServiceHealth) error  { return nil }
func (f *fakeQueue) Claim(context.Context, string, int, int) ([]Job, error) { return nil, nil }
func (f *fakeQueue) Heartbeat(_ context.Context, ids []string, _ int) (map[string]bool, map[string]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeats++
	f.heartbeatIDs = append(f.heartbeatIDs, append([]string{}, ids...))
	return cloneBoolMap(f.canceled), cloneBoolMap(f.lost), f.heartbeatErr
}
func (f *fakeQueue) Progress(_ context.Context, updates []ProgressUpdate) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progress = append(f.progress, updates...)
	return nil
}
func (f *fakeQueue) Complete(context.Context, string, map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completes++
	if len(f.completeErrors) == 0 {
		return nil
	}
	err := f.completeErrors[0]
	f.completeErrors = f.completeErrors[1:]
	return err
}
func (f *fakeQueue) Fail(_ context.Context, _ string, message string, retryable bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails = append(f.fails, struct {
		retryable bool
		message   string
	}{retryable, message})
	return nil
}

func cloneBoolMap(input map[string]bool) map[string]bool {
	out := map[string]bool{}
	for key, value := range input {
		out[key] = value
	}
	return out
}

func TestBatchContextRenewsWholeBatchAndDistributesState(t *testing.T) {
	queue := &fakeQueue{canceled: map[string]bool{"a": true}, lost: map[string]bool{"b": true}}
	batch := NewBatchContext(queue, []string{"a", "b"}, time.Second, 10*time.Millisecond)
	batch.Start(context.Background())
	defer batch.Close()
	if err := batch.Check("a", floatPtr(.4), stringPtr("working")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		queue.mu.Lock()
		beats := queue.heartbeats
		queue.mu.Unlock()
		if beats > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !errors.Is(batch.Check("a", nil, nil), ErrCanceled) {
		t.Fatal("cancel was not distributed")
	}
	if !errors.Is(batch.Check("b", nil, nil), ErrLeaseLost) {
		t.Fatal("lost lease was not distributed")
	}
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if len(queue.heartbeatIDs) == 0 || len(queue.heartbeatIDs[0]) != 2 {
		t.Fatalf("heartbeat did not renew the batch: %#v", queue.heartbeatIDs)
	}
}

func TestRunnerCompletionRetriesAndClassifiesErrors(t *testing.T) {
	old := completionRetryDelays
	completionRetryDelays = []time.Duration{0, time.Millisecond, time.Millisecond}
	defer func() { completionRetryDelays = old }()
	queue := &fakeQueue{completeErrors: []error{errors.New("network"), errors.New("network")}}
	runner := &Runner{client: queue}
	runner.reportDone(context.Background(), "00000000-job", map[string]any{"ok": true}, nil)
	if queue.completes != 3 {
		t.Fatalf("complete calls=%d, want 3", queue.completes)
	}

	queue.completeErrors = []error{ErrLeaseLost}
	queue.completes = 0
	runner.reportDone(context.Background(), "00000000-job", map[string]any{}, nil)
	if queue.completes != 1 {
		t.Fatalf("lease loss retried %d times", queue.completes)
	}

	batch := NewBatchContext(queue, []string{"bad"}, time.Second, time.Second)
	runner.settle(context.Background(), jobResult{job: Job{ID: "bad"}, err: permanentError("bad payload")}, batch)
	if len(queue.fails) != 1 || queue.fails[0].retryable {
		t.Fatalf("permanent error was retryable: %#v", queue.fails)
	}
}

func TestCompletionStopsWhenCancellationArrives(t *testing.T) {
	old := completionRetryDelays
	completionRetryDelays = []time.Duration{0, 20 * time.Millisecond}
	defer func() { completionRetryDelays = old }()
	queue := &fakeQueue{completeErrors: []error{errors.New("network")}}
	runner := &Runner{client: queue}
	batch := NewBatchContext(queue, []string{"job"}, time.Second, time.Second)
	go func() {
		time.Sleep(5 * time.Millisecond)
		batch.mu.Lock()
		batch.canceled["job"] = true
		batch.mu.Unlock()
	}()
	runner.reportDone(context.Background(), "job", map[string]any{}, batch)
	if queue.completes != 1 {
		t.Fatalf("completion continued after cancel: %d calls", queue.completes)
	}
	if len(queue.fails) != 1 || queue.fails[0].message != "canceled by user" {
		t.Fatalf("cancel was not settled: %#v", queue.fails)
	}
}
