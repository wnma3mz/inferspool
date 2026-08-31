package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLaunchSpecFromEnvironment(t *testing.T) {
	t.Setenv("INFERSPOOL_IMAGE_LAUNCH", "start-image")
	t.Setenv("INFERSPOOL_IMAGE_STOP", "stop-image")
	t.Setenv("INFERSPOOL_IMAGE_READY_TIMEOUT", "12.5")
	t.Setenv("INFERSPOOL_IMAGE_IDLE_TIMEOUT", "0")
	t.Setenv("INFERSPOOL_IMAGE_WARMUP_SECS", "0.25")
	spec, err := launchSpecFromEnv("image")
	if err != nil {
		t.Fatal(err)
	}
	if spec == nil || spec.Command != "start-image" || spec.StopCommand != "stop-image" {
		t.Fatalf("bad spec: %#v", spec)
	}
	if spec.ReadyTimeout != 12500*time.Millisecond || spec.IdleTimeout != 0 || spec.Warmup != 250*time.Millisecond {
		t.Fatalf("bad durations: %#v", spec)
	}
}

func TestSupervisorReportsLaunchFailure(t *testing.T) {
	supervisor := NewSupervisor(map[string]LaunchSpec{"image": {
		Type: "image", Command: "exit 3", ReadyTimeout: time.Second, Warmup: 20 * time.Millisecond,
	}}, true, 100*time.Millisecond)
	if supervisor.Ensure("image", func() bool { return false }) {
		t.Fatal("failed command reported ready")
	}
	if supervisor.Current() != "" {
		t.Fatalf("failed service remains current: %q", supervisor.Current())
	}
	if !supervisor.Ensure("llm", func() bool { return true }) {
		t.Fatal("unmanaged service did not use its probe")
	}
}

func TestSupervisorRechecksReadinessBeforeClaim(t *testing.T) {
	supervisor := NewSupervisor(map[string]LaunchSpec{"image": {
		Type: "image", Command: successCommand(), StopCommand: successCommand(),
		ReadyTimeout: time.Second,
	}}, true, time.Second)
	if !supervisor.Ensure("image", func() bool { return true }) {
		t.Fatal("initial readiness failed")
	}
	if supervisor.Ensure("image", func() bool { return false }) {
		t.Fatal("running process bypassed health probe")
	}
	supervisor.StopAll()
}

func TestSupervisorStopCommandAndIdleReaping(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "stopped")
	stop := "touch " + shellQuote(marker)
	if runtime.GOOS == "windows" {
		stop = "type nul > " + marker
	}
	supervisor := NewSupervisor(map[string]LaunchSpec{"image": {
		Type: "image", Command: successCommand(), StopCommand: stop,
		ReadyTimeout: time.Second, IdleTimeout: 20 * time.Millisecond,
	}}, true, time.Second)
	if !supervisor.Ensure("image", func() bool { return true }) {
		t.Fatal("service did not become ready")
	}
	time.Sleep(30 * time.Millisecond)
	if got := supervisor.ReapIdle(); got != "image" {
		t.Fatalf("reaped %q, want image", got)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("stop command did not run: %v", err)
	}
}

func successCommand() string {
	if runtime.GOOS == "windows" {
		return "exit 0"
	}
	return "true"
}

func shellQuote(value string) string { return "'" + value + "'" }
