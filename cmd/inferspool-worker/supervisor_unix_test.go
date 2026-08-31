//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSupervisorReapsWholeProcessGroup(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "child.pid")
	command := fmt.Sprintf("sleep 300 & echo $! > %s; wait", shellQuote(pidFile))
	supervisor := NewSupervisor(map[string]LaunchSpec{"image": {
		Type: "image", Command: command, ReadyTimeout: 3 * time.Second,
		Warmup: 20 * time.Millisecond,
	}}, true, 200*time.Millisecond)
	ready := func() bool { _, err := os.Stat(pidFile); return err == nil }
	if !supervisor.Ensure("image", ready) {
		t.Fatal("test service did not start")
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })

	supervisor.StopAll()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child process %d survived process-group shutdown", pid)
}
