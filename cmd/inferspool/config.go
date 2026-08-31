package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

var (
	defaultServerURL  = "https://ldsybuoxeikvjkswlksu.supabase.co/functions/v1/api"
	defaultGatewayKey = "sb_publishable__KvOD-xdJ3P3gy487FI2sg_UIG8b1fJ"
)

// Config is the product-facing client configuration. gatewayKey is an internal
// transport detail and is never written to or shown from the user config.
type Config struct {
	ServerURL  string  `json:"server_url,omitempty"`
	APIKey     string  `json:"api_key"`
	Session    Session `json:"session,omitempty"`
	gatewayKey string
}

type Session struct {
	AccessToken  string    `json:"access_token,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	Email        string    `json:"email,omitempty"`
}

func (s Session) Empty() bool { return s.AccessToken == "" && s.RefreshToken == "" }

// storedConfig accepts both the product names and fields written by older
// releases, so upgrades do not require users to configure the CLI again.
type storedConfig struct {
	ServerURL        string  `json:"server_url,omitempty"`
	APIKey           string  `json:"api_key,omitempty"`
	URL              string  `json:"url,omitempty"`
	Key              string  `json:"key,omitempty"`
	LegacyGatewayKey string  `json:"anon_key,omitempty"`
	Session          Session `json:"session,omitempty"`
}

func configPath() string {
	if dir := os.Getenv("INFERSPOOL_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "config.json")
	}

	// Follow each platform's convention rather than forcing ~/.config.
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("APPDATA")
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(home, "Library", "Application Support")
		}
	default:
		if base = os.Getenv("XDG_CONFIG_HOME"); base == "" {
			if home, err := os.UserHomeDir(); err == nil {
				base = filepath.Join(home, ".config")
			}
		}
	}
	if base == "" {
		base = "."
	}
	return filepath.Join(base, "inferspool", "config.json")
}

func loadConfig() (Config, error) {
	cfg := Config{ServerURL: defaultServerURL, gatewayKey: defaultGatewayKey}

	if data, err := os.ReadFile(configPath()); err == nil {
		var stored storedConfig
		if err := json.Unmarshal(data, &stored); err != nil {
			return cfg, fmt.Errorf("%s is not valid JSON: %w", configPath(), err)
		}
		if stored.ServerURL != "" {
			cfg.ServerURL = stored.ServerURL
		} else if stored.URL != "" {
			cfg.ServerURL = stored.URL
		}
		if stored.APIKey != "" {
			cfg.APIKey = stored.APIKey
		} else {
			cfg.APIKey = stored.Key
		}
		if stored.LegacyGatewayKey != "" {
			cfg.gatewayKey = stored.LegacyGatewayKey
		}
		cfg.Session = stored.Session
	} else if !os.IsNotExist(err) {
		return cfg, err
	}

	// Environment wins, so CI and containers need no config file.
	if v := os.Getenv("INFERSPOOL_URL"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("INFERSPOOL_API_KEY"); v != "" {
		cfg.APIKey = v
	} else if v := os.Getenv("INFERSPOOL_KEY"); v != "" { // pre-product compatibility
		cfg.APIKey = v
	}
	if v := os.Getenv("INFERSPOOL_GATEWAY_KEY"); v != "" {
		cfg.gatewayKey = v
	} else if v := os.Getenv("INFERSPOOL_ANON_KEY"); v != "" { // legacy internal name
		cfg.gatewayKey = v
	}
	return cfg, nil
}

func saveConfig(mutate func(*Config)) error {
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	var stored storedConfig
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &stored)
	}
	cfg := Config{ServerURL: stored.ServerURL, APIKey: stored.APIKey, Session: stored.Session}
	if cfg.ServerURL == "" {
		cfg.ServerURL = stored.URL
	}
	if cfg.APIKey == "" {
		cfg.APIKey = stored.Key
	}
	mutate(&cfg)

	data, err := json.MarshalIndent(storedConfig{
		ServerURL: cfg.ServerURL,
		APIKey:    cfg.APIKey,
		Session:   cfg.Session,
		// Retain an old private deployment's transport setting without exposing
		// it through commands. New official configs never write this field.
		LegacyGatewayKey: stored.LegacyGatewayKey,
	}, "", "  ")
	if err != nil {
		return err
	}
	// WriteFile's mode only applies when creating a file. Chmod also repairs an
	// older config that was accidentally created too broadly before sessions
	// were stored here.
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// redact keeps enough of a key to identify it without exposing the secret.
func redact(key string) string {
	if key == "" {
		return "(unset)"
	}
	if len(key) <= 14 {
		return "…"
	}
	return key[:14] + "…"
}
