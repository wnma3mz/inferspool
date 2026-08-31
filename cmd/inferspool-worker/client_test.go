package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestQueueClientRPCShapesAndLeaseFencing(t *testing.T) {
	var calls []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, body)
		switch r.URL.Path {
		case "/v1/workers/pending":
			json.NewEncoder(w).Encode([]map[string]any{{"type": "llm", "n": 2}})
		case "/v1/workers/heartbeat":
			json.NewEncoder(w).Encode([]map[string]any{{"id": "a", "cancel_requested": true}})
		case "/v1/workers/complete":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"P0002","message":"lease lost"}`))
		}
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, gatewayKey: "gateway", WorkerID: "gpu", WorkerToken: "token"}
	client := NewQueueClient(cfg)
	pending, err := client.PendingByType(context.Background())
	if err != nil || pending["llm"] != 2 {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
	canceled, lost, err := client.Heartbeat(context.Background(), []string{"a", "b"}, 60)
	if err != nil || !canceled["a"] || !lost["b"] {
		t.Fatalf("canceled=%v lost=%v err=%v", canceled, lost, err)
	}
	if err := client.Complete(context.Background(), "a", map[string]any{}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("got %v", err)
	}
	if len(calls) != 3 {
		t.Fatalf("calls=%d", len(calls))
	}
}
