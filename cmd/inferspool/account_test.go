package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAccountLoginRefreshAndKeyManagement(t *testing.T) {
	var loginPassword, authHeader, revokedID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/session" && r.Method == http.MethodPost:
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			loginPassword = body["password"]
			json.NewEncoder(w).Encode(map[string]any{
				"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600,
				"user": map[string]string{"email": body["email"]},
			})
		case r.URL.Path == "/v1/session/refresh":
			json.NewEncoder(w).Encode(map[string]any{
				"access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600,
			})
		case r.URL.Path == "/v1/keys" && r.Method == http.MethodPost:
			authHeader = r.Header.Get("Authorization")
			json.NewEncoder(w).Encode("inferspool_prefix_secret")
		case r.URL.Path == "/v1/keys" && r.Method == http.MethodGet:
			json.NewEncoder(w).Encode([]map[string]any{{
				"id": "key-id", "prefix": "prefix", "label": "laptop",
				"created_at": time.Now().UTC().Format(time.RFC3339),
			}})
		case strings.HasPrefix(r.URL.Path, "/v1/keys/") && r.Method == http.MethodDelete:
			revokedID = strings.TrimPrefix(r.URL.Path, "/v1/keys/")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	cfg := Config{ServerURL: server.URL, gatewayKey: "gateway"}
	account := NewAccountClient(cfg)
	session, err := account.Login("user@example.com", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if loginPassword != "correct horse" || session.Email != "user@example.com" {
		t.Fatalf("login request/session mismatch: password=%q session=%#v", loginPassword, session)
	}

	cfg.Session = Session{RefreshToken: "refresh-1", ExpiresAt: time.Now().Add(-time.Minute), Email: session.Email}
	account = NewAccountClient(cfg)
	key, err := account.CreateKey("laptop")
	if err != nil {
		t.Fatal(err)
	}
	if key != "inferspool_prefix_secret" || authHeader != "Bearer access-2" {
		t.Fatalf("key=%q auth=%q", key, authHeader)
	}
	keys, err := account.ListKeys()
	if err != nil || len(keys) != 1 || keys[0].ID != "key-id" {
		t.Fatalf("keys=%#v err=%v", keys, err)
	}
	if err := account.RevokeKey("key-id"); err != nil {
		t.Fatal(err)
	}
	if revokedID != "key-id" {
		t.Fatalf("revoke filter = %q", revokedID)
	}

	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "correct horse") {
		t.Fatal("password must never be persisted")
	}
}

func TestLoginCommandFromStdinCreatesAndSavesKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/session":
			json.NewEncoder(w).Encode(map[string]any{
				"access_token": "access", "refresh_token": "refresh", "expires_in": 3600,
				"user": map[string]string{"email": "cli@example.com"},
			})
		case "/v1/me":
			json.NewEncoder(w).Encode(map[string]any{
				"id": "user", "email": "cli@example.com", "admin": false,
				"profile": map[string]any{"status": "active", "force_password_change": false},
			})
		case "/v1/keys":
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode("inferspool_cli_secret")
				return
			}
			json.NewEncoder(w).Encode([]any{})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	t.Setenv("INFERSPOOL_URL", server.URL)
	t.Setenv("INFERSPOOL_GATEWAY_KEY", "gateway")
	oldStdin := os.Stdin
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(write, "password-from-stdin\n")
	_ = write.Close()
	os.Stdin = read
	t.Cleanup(func() { os.Stdin = oldStdin; _ = read.Close() })

	if code, err := cmdLogin([]string{"cli@example.com", "--password-stdin"}); err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "inferspool_cli_secret" || cfg.Session.Email != "cli@example.com" {
		t.Fatalf("login did not persist ready config: %#v", cfg)
	}
	data, _ := os.ReadFile(configPath())
	if strings.Contains(string(data), "password-from-stdin") {
		t.Fatal("password must never be persisted")
	}
}

func TestPasswordCommandCompletesInvitedAccountSetup(t *testing.T) {
	var password string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/me/password" && r.Method == http.MethodPost:
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			password = body["password"]
			json.NewEncoder(w).Encode(map[string]bool{"changed": true})
		case r.URL.Path == "/v1/keys" && r.Method == http.MethodGet:
			json.NewEncoder(w).Encode([]any{})
		case r.URL.Path == "/v1/keys" && r.Method == http.MethodPost:
			json.NewEncoder(w).Encode("inferspool_ready_secret")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	if err := saveConfig(func(cfg *Config) {
		cfg.ServerURL = server.URL
		cfg.Session = Session{AccessToken: "access", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour), Email: "invite@example.com"}
	}); err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(write, "new-password\n")
	_ = write.Close()
	os.Stdin = read
	t.Cleanup(func() { os.Stdin = oldStdin; _ = read.Close() })
	if code, err := cmdPassword([]string{"--password-stdin"}); err != nil || code != 0 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	cfg, err := loadConfig()
	if err != nil || password != "new-password" || cfg.APIKey != "inferspool_ready_secret" {
		t.Fatalf("password=%q key=%q err=%v", password, cfg.APIKey, err)
	}
}

func TestKeyHelpers(t *testing.T) {
	keys := []APIKeyInfo{{Prefix: "abc"}}
	if !configuredKeyBelongsTo("inferspool_abc_secret", keys) {
		t.Fatal("configured key should match its server-side prefix")
	}
	if configuredKeyBelongsTo("inferspool_other_secret", keys) {
		t.Fatal("a different account key must not be reused")
	}
	if _, err := keyCreateLabel([]string{"--bad"}); err == nil {
		t.Fatal("invalid key create flags should fail")
	}
}

func TestWhoamiAndLogoutUseStoredSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/session" || r.Method != http.MethodDelete {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	dir := t.TempDir()
	t.Setenv("INFERSPOOL_CONFIG_DIR", dir)
	if err := saveConfig(func(cfg *Config) {
		cfg.ServerURL = server.URL
		cfg.APIKey = "inferspool_prefix_secret"
		cfg.Session = Session{
			AccessToken: "access", RefreshToken: "refresh",
			ExpiresAt: time.Now().Add(time.Hour), Email: "user@example.com",
		}
	}); err != nil {
		t.Fatal(err)
	}
	if code, err := cmdWhoami(nil); err != nil || code != 0 {
		t.Fatalf("whoami code=%d err=%v", code, err)
	}
	if code, err := cmdLogout(nil); err != nil || code != 0 {
		t.Fatalf("logout code=%d err=%v", code, err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "" || !cfg.Session.Empty() {
		t.Fatalf("logout retained credentials: %#v", cfg)
	}
}
