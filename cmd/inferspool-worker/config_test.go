package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadEnvFileProcessEnvironmentWins(t *testing.T) {
	t.Setenv("INFERSPOOL_ENV_WINNER", "process")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("INFERSPOOL_ENV_WINNER=file\nINFERSPOOL_FROM_FILE='yes'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("INFERSPOOL_FROM_FILE") })
	if err := loadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("INFERSPOOL_ENV_WINNER"); got != "process" {
		t.Fatalf("process env lost: %q", got)
	}
	if got := os.Getenv("INFERSPOOL_FROM_FILE"); got != "yes" {
		t.Fatalf("env file not loaded: %q", got)
	}
}

func TestLoadConfigHeartbeatFloorAndServices(t *testing.T) {
	for _, name := range []string{"INFERSPOOL_LEASE_SECS", "INFERSPOOL_HEARTBEAT_SECS", "INFERSPOOL_LLM_URL"} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	t.Setenv("INFERSPOOL_LEASE_SECS", "1")
	t.Setenv("INFERSPOOL_LLM_URL", "http://127.0.0.1:8000/")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Heartbeat != time.Second {
		t.Fatalf("heartbeat=%s, want 1s", cfg.Heartbeat)
	}
	if cfg.LLMURL != "http://127.0.0.1:8000" {
		t.Fatalf("url not normalized: %q", cfg.LLMURL)
	}
	if specs := buildSpecs(cfg); len(specs) != 1 || specs[0].Type != "llm" {
		t.Fatalf("unexpected specs: %#v", specs)
	}
}

func TestLoadConfigUsesProductCredentials(t *testing.T) {
	for _, name := range []string{
		"INFERSPOOL_URL", "INFERSPOOL_GATEWAY_KEY", "INFERSPOOL_WORKER_ID",
		"INFERSPOOL_WORKER_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY",
		"WORKER_ID", "WORKER_TOKEN",
	} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	t.Setenv("INFERSPOOL_URL", "https://api.example/")
	t.Setenv("INFERSPOOL_WORKER_ID", "gpu-1")
	t.Setenv("INFERSPOOL_WORKER_TOKEN", "worker-token")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://api.example" || cfg.WorkerID != "gpu-1" || cfg.WorkerToken != "worker-token" {
		t.Fatalf("unexpected product config: %#v", cfg)
	}
	if cfg.gatewayKey != defaultGatewayKey {
		t.Fatal("official transport configuration should be built in")
	}
	if err := cfg.validateServer(); err != nil {
		t.Fatalf("product-facing configuration should be complete: %v", err)
	}
}

func TestLoadConfigAcceptsLegacyWorkerEnvironment(t *testing.T) {
	for _, name := range []string{
		"INFERSPOOL_URL", "INFERSPOOL_GATEWAY_KEY", "INFERSPOOL_WORKER_ID",
		"INFERSPOOL_WORKER_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY",
		"WORKER_ID", "WORKER_TOKEN",
	} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	t.Setenv("SUPABASE_URL", "https://legacy.example")
	t.Setenv("SUPABASE_ANON_KEY", "legacy-gateway")
	t.Setenv("WORKER_ID", "legacy-gpu")
	t.Setenv("WORKER_TOKEN", "legacy-token")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://legacy.example" || cfg.gatewayKey != "legacy-gateway" ||
		cfg.WorkerID != "legacy-gpu" || cfg.WorkerToken != "legacy-token" {
		t.Fatalf("legacy worker environment not migrated: %#v", cfg)
	}
}
