package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseFlagsMixedOrder(t *testing.T) {
	// Positional arguments and flags must work in any order, which is why this
	// does not use the stdlib FlagSet.
	f, err := parseFlags([]string{"llm", "--priority", "5", "hello", "-w", "world"})
	if err != nil {
		t.Fatal(err)
	}
	if f.priority != 5 {
		t.Errorf("priority = %d, want 5", f.priority)
	}
	if !f.wait {
		t.Error("wait should be set")
	}
	if got := strings.Join(f.rest, " "); got != "llm hello world" {
		t.Errorf("rest = %q, want \"llm hello world\"", got)
	}
}

func TestParseFlagsDefaults(t *testing.T) {
	f, err := parseFlags([]string{})
	if err != nil {
		t.Fatal(err)
	}
	if f.limit != 20 {
		t.Errorf("default limit = %d, want 20", f.limit)
	}
	if f.wait || f.quiet || f.jsonOut {
		t.Error("booleans should default to false")
	}
}

func TestParseFlagsErrors(t *testing.T) {
	if _, err := parseFlags([]string{"--limit"}); err == nil {
		t.Error("a flag missing its value should error")
	}
	if _, err := parseFlags([]string{"--nope"}); err == nil {
		t.Error("an unknown flag should error")
	}
	if _, err := parseFlags([]string{"--model", "qwen"}); err == nil {
		t.Error("model selection belongs to the GPU worker, not the submitting client")
	}
	if _, err := parseFlags([]string{"--limit", "abc"}); err == nil {
		t.Error("a non-numeric limit should error")
	}
}

func TestBatchKeyDeterministic(t *testing.T) {
	a := batchKey("llm", "hello", "")
	b := batchKey("llm", "hello", "")
	if a != b {
		t.Error("the same line must produce the same key, or re-running a " +
			"batch file would duplicate work")
	}
	if batchKey("llm", "hello", "") == batchKey("llm", "world", "") {
		t.Error("different lines must produce different keys")
	}
	if batchKey("llm", "hello", "") == batchKey("tts", "hello", "") {
		t.Error("different types must produce different keys")
	}
	if batchKey("llm", "hello", "") == batchKey("llm", "hello", "run2") {
		t.Error("--tag must produce a fresh key")
	}
}

func TestPromptField(t *testing.T) {
	if promptField("tts") != "text" {
		t.Error("tts payloads use the text field")
	}
	for _, ty := range []string{"llm", "image", "video"} {
		if promptField(ty) != "prompt" {
			t.Errorf("%s should use the prompt field", ty)
		}
	}
}

func TestStableTaskFlagsBuildPayload(t *testing.T) {
	f, err := parseFlags([]string{"--temperature", "0.3", "--max-tokens", "2048"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := buildPayload("llm", "hello", f)
	if err != nil {
		t.Fatal(err)
	}
	if payload["temperature"] != 0.3 || payload["max_tokens"] != 2048 {
		t.Fatalf("payload=%#v", payload)
	}
	f, _ = parseFlags([]string{"--size", "1024x1024", "--steps", "30"})
	payload, err = buildPayload("image", "cat", f)
	if err != nil || payload["size"] != "1024x1024" || payload["num_inference_steps"] != 30 {
		t.Fatalf("payload=%#v err=%v", payload, err)
	}
	f, _ = parseFlags([]string{"--voice", "female", "--speed", "1.25", "--format", "mp3"})
	payload, err = buildPayload("tts", "read", f)
	if err != nil || payload["voice"] != "female" || payload["response_format"] != "mp3" {
		t.Fatalf("payload=%#v err=%v", payload, err)
	}
	if _, err := buildPayload("image", "bad", flags{temperature: "0.5"}); err == nil {
		t.Fatal("llm-only flags must be rejected")
	}
}

func TestConfigRoundTripAndPermissions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := saveConfig(func(c *Config) { c.ServerURL = "https://x.example" }); err != nil {
		t.Fatal(err)
	}
	if err := saveConfig(func(c *Config) { c.APIKey = "inferspool_pre_secret" }); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	// A second save must not clobber the first field.
	if cfg.ServerURL != "https://x.example" {
		t.Errorf("url = %q, want it preserved across saves", cfg.ServerURL)
	}
	if cfg.APIKey != "inferspool_pre_secret" {
		t.Errorf("key = %q", cfg.APIKey)
	}

	info, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config perms = %o, want 600: the file holds a credential", perm)
	}
}

func TestConfigEnvironmentWins(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	if err := saveConfig(func(c *Config) { c.ServerURL = "https://from-file" }); err != nil {
		t.Fatal(err)
	}

	t.Setenv("INFERSPOOL_URL", "https://from-env")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://from-env" {
		t.Errorf("url = %q, want the environment to win", cfg.ServerURL)
	}
}

func TestConfigUsesBuiltInServiceDefaults(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	t.Setenv("INFERSPOOL_URL", "")
	t.Setenv("INFERSPOOL_GATEWAY_KEY", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != defaultServerURL {
		t.Errorf("url = %q, want built-in service URL", cfg.ServerURL)
	}
	if cfg.gatewayKey != defaultGatewayKey {
		t.Errorf("gateway key = %q, want built-in transport configuration", cfg.gatewayKey)
	}
	if cfg.APIKey != "" {
		t.Errorf("API key = %q, want users to configure it", cfg.APIKey)
	}
}

func TestLegacyConfigMigratesToProductFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	legacy := `{"url":"https://legacy.example","anon_key":"legacy-gateway","key":"inferspool_legacy_key"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "https://legacy.example" || cfg.APIKey != "inferspool_legacy_key" {
		t.Fatalf("legacy config not migrated: %#v", cfg)
	}
	if cfg.gatewayKey != "legacy-gateway" {
		t.Fatal("legacy private deployment gateway config was not retained")
	}
}

func TestRedactNeverLeaksFullKey(t *testing.T) {
	full := "inferspool_abcdef_supersecretvalue"
	got := redact(full)
	if strings.Contains(got, "supersecret") {
		t.Errorf("redact leaked the secret: %q", got)
	}
	if redact("") != "(unset)" {
		t.Error("an empty key should read as unset")
	}
	// A short key must not be echoed either.
	if redact("inferspool_a_b") == "inferspool_a_b" {
		t.Error("short keys must still be redacted")
	}
}

func TestNewClientRequiresConfig(t *testing.T) {
	if _, err := NewClient(Config{}); err == nil {
		t.Error("an empty config should be rejected")
	}
	_, err := NewClient(Config{ServerURL: "https://x", gatewayKey: "a"})
	if err == nil || !strings.Contains(err.Error(), "key") {
		t.Errorf("a missing api key should be reported, got %v", err)
	}
	if _, err := NewClient(Config{ServerURL: "https://x", gatewayKey: "a", APIKey: "k"}); err != nil {
		t.Errorf("a complete config should be accepted: %v", err)
	}
}

func TestJobTerminal(t *testing.T) {
	for _, s := range []string{"succeeded", "failed", "canceled"} {
		if !(Job{Status: s}).Terminal() {
			t.Errorf("%s should be terminal", s)
		}
	}
	for _, s := range []string{"queued", "running"} {
		if (Job{Status: s}).Terminal() {
			t.Errorf("%s should not be terminal", s)
		}
	}
}

func TestJobDescribeHandlesBothFields(t *testing.T) {
	llm := Job{Payload: json.RawMessage(`{"prompt":"a cat"}`)}
	if llm.Describe() != "a cat" {
		t.Errorf("got %q", llm.Describe())
	}
	tts := Job{Payload: json.RawMessage(`{"text":"read this"}`)}
	if tts.Describe() != "read this" {
		t.Errorf("got %q", tts.Describe())
	}
	// Long prompts are truncated, and newlines must not break the table.
	long := Job{Payload: json.RawMessage(`{"prompt":"` + strings.Repeat("x", 100) + `"}`)}
	if len([]rune(long.Describe())) > 48 {
		t.Errorf("describe should truncate, got %d chars", len(long.Describe()))
	}
	multi := Job{Payload: json.RawMessage(`{"prompt":"one\ntwo"}`)}
	if strings.Contains(multi.Describe(), "\n") {
		t.Error("newlines must be stripped from list output")
	}
	// Malformed payloads must not panic.
	bad := Job{Payload: json.RawMessage(`not json`)}
	_ = bad.Describe()
}

func TestEmptyJobListMarshalsAsArray(t *testing.T) {
	// A nil slice marshals to "null", which breaks `inferspool list --json | jq`.
	// cmdList substitutes an empty slice; verify the contract holds.
	var nilJobs []Job
	if got := mustJSON(nilJobs); got != "null" {
		t.Fatalf("premise changed: nil slice marshals to %q", got)
	}
	if got := mustJSON([]Job{}); got != "[]" {
		t.Errorf("empty slice should marshal to [], got %q", got)
	}
}
