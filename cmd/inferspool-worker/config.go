package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ServerURL   string
	WorkerID    string
	WorkerToken string
	gatewayKey  string

	Lease       time.Duration
	Heartbeat   time.Duration
	IdlePoll    time.Duration
	ReportEvery time.Duration
	RequestTime time.Duration
	LogLevel    string
	Exclusive   bool
	StopGrace   time.Duration

	LLMURL, ImageURL, VideoURL, TTSURL string
	LLMCapacity                        int
	ImageCapacity, VideoCapacity       int
	TTSCapacity                        int
}

var (
	defaultServerURL  = "https://ldsybuoxeikvjkswlksu.supabase.co/functions/v1/api"
	defaultGatewayKey = "sb_publishable__KvOD-xdJ3P3gy487FI2sg_UIG8b1fJ"
)

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

func productEnv(name, legacy, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	if value := os.Getenv(legacy); value != "" {
		return value
	}
	return fallback
}

func loadEnvFile(path string) error {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for line := 1; scanner.Scan(); line++ {
		s := strings.TrimSpace(scanner.Text())
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		s = strings.TrimSpace(strings.TrimPrefix(s, "export "))
		key, value, ok := strings.Cut(s, "=")
		if !ok || strings.TrimSpace(key) == "" {
			return fmt.Errorf("%s:%d: expected KEY=VALUE", path, line)
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') ||
			(value[0] == '"' && value[len(value)-1] == '"')) {
			value = value[1 : len(value)-1]
		}
		// The process environment wins over an env file.
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

func envString(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) (int, error) {
	value := envString(name, strconv.Itoa(fallback))
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return n, nil
}

func envFloat(name string, fallback float64) (float64, error) {
	value := envString(name, strconv.FormatFloat(fallback, 'f', -1, 64))
	n, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", name, err)
	}
	return n, nil
}

func loadConfig() (Config, error) {
	leaseSeconds, err := envInt("INFERSPOOL_LEASE_SECS", 120)
	if err != nil {
		return Config{}, err
	}
	heartbeatSeconds, err := envInt("INFERSPOOL_HEARTBEAT_SECS", max(1, leaseSeconds/3))
	if err != nil {
		return Config{}, err
	}
	idleSeconds, err := envFloat("INFERSPOOL_IDLE_POLL_SECS", 3)
	if err != nil {
		return Config{}, err
	}
	reportSeconds, err := envFloat("INFERSPOOL_REPORT_SECS", 20)
	if err != nil {
		return Config{}, err
	}
	requestSeconds, err := envFloat("INFERSPOOL_REQUEST_TIMEOUT", 1800)
	if err != nil {
		return Config{}, err
	}
	stopSeconds, err := envFloat("INFERSPOOL_STOP_GRACE_SECS", 30)
	if err != nil {
		return Config{}, err
	}
	c := Config{
		ServerURL:   strings.TrimRight(productEnv("INFERSPOOL_URL", "SUPABASE_URL", defaultServerURL), "/"),
		gatewayKey:  productEnv("INFERSPOOL_GATEWAY_KEY", "SUPABASE_ANON_KEY", defaultGatewayKey),
		WorkerID:    firstEnv("INFERSPOOL_WORKER_ID", "WORKER_ID"),
		WorkerToken: firstEnv("INFERSPOOL_WORKER_TOKEN", "WORKER_TOKEN"),
		Lease:       time.Duration(max(1, leaseSeconds)) * time.Second,
		Heartbeat:   time.Duration(max(1, heartbeatSeconds)) * time.Second,
		IdlePoll:    time.Duration(idleSeconds * float64(time.Second)),
		ReportEvery: time.Duration(reportSeconds * float64(time.Second)),
		RequestTime: time.Duration(requestSeconds * float64(time.Second)),
		StopGrace:   time.Duration(stopSeconds * float64(time.Second)),
		LogLevel:    strings.ToUpper(envString("INFERSPOOL_LOG_LEVEL", "INFO")),
		Exclusive:   envString("INFERSPOOL_EXCLUSIVE_GPU", "1") == "1",
		LLMURL:      strings.TrimRight(os.Getenv("INFERSPOOL_LLM_URL"), "/"),
		ImageURL:    strings.TrimRight(os.Getenv("INFERSPOOL_IMAGE_URL"), "/"),
		VideoURL:    strings.TrimRight(os.Getenv("INFERSPOOL_VIDEO_URL"), "/"),
		TTSURL:      strings.TrimRight(os.Getenv("INFERSPOOL_TTS_URL"), "/"),
	}
	capacities := []struct {
		name     string
		fallback int
		out      *int
	}{
		{"INFERSPOOL_LLM_CAPACITY", 8, &c.LLMCapacity},
		{"INFERSPOOL_IMAGE_CAPACITY", 1, &c.ImageCapacity}, {"INFERSPOOL_VIDEO_CAPACITY", 1, &c.VideoCapacity},
		{"INFERSPOOL_TTS_CAPACITY", 2, &c.TTSCapacity},
	}
	for _, item := range capacities {
		value, err := envInt(item.name, item.fallback)
		if err != nil {
			return Config{}, err
		}
		*item.out = max(1, value)
	}
	if c.IdlePoll <= 0 || c.ReportEvery <= 0 || c.RequestTime <= 0 {
		return Config{}, errors.New("poll, report, and request timeouts must be positive")
	}
	return c, nil
}

func (c Config) validateServer() error {
	var missing []string
	for name, value := range map[string]string{
		"INFERSPOOL_URL": c.ServerURL, "internal gateway configuration": c.gatewayKey,
		"INFERSPOOL_WORKER_ID": c.WorkerID, "INFERSPOOL_WORKER_TOKEN": c.WorkerToken,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}
	return nil
}
