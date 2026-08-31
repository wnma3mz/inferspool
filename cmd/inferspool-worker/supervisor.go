package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"sync"
	"time"
)

type LaunchSpec struct {
	Type         string
	Command      string
	StopCommand  string
	CWD          string
	ReadyTimeout time.Duration
	IdleTimeout  time.Duration
	Warmup       time.Duration
}

func launchSpecFromEnv(jobType string) (*LaunchSpec, error) {
	prefix := "INFERSPOOL_" + stringsUpper(jobType) + "_"
	command := os.Getenv(prefix + "LAUNCH")
	if command == "" {
		return nil, nil
	}
	ready, err := envDuration(prefix+"READY_TIMEOUT", 600)
	if err != nil {
		return nil, err
	}
	idle, err := envDuration(prefix+"IDLE_TIMEOUT", 600)
	if err != nil {
		return nil, err
	}
	warmup, err := envDuration(prefix+"WARMUP_SECS", 5)
	if err != nil {
		return nil, err
	}
	return &LaunchSpec{Type: jobType, Command: command, StopCommand: os.Getenv(prefix + "STOP"),
		CWD: os.Getenv(prefix + "CWD"), ReadyTimeout: ready, IdleTimeout: idle, Warmup: warmup}, nil
}

func envDuration(name string, fallback float64) (time.Duration, error) {
	value := envString(name, strconv.FormatFloat(fallback, 'f', -1, 64))
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", name, err)
	}
	if seconds < 0 {
		return 0, fmt.Errorf("%s must not be negative", name)
	}
	return time.Duration(seconds * float64(time.Second)), nil
}

func stringsUpper(value string) string {
	data := []byte(value)
	for i, c := range data {
		if c >= 'a' && c <= 'z' {
			data[i] = c - ('a' - 'A')
		}
	}
	return string(data)
}

type runningService struct {
	spec     LaunchSpec
	process  *exec.Cmd
	done     <-chan struct{}
	started  time.Time
	lastUsed time.Time
}

type Supervisor struct {
	mu        sync.Mutex
	specs     map[string]LaunchSpec
	exclusive bool
	stopGrace time.Duration
	running   *runningService
}

func buildSupervisor(cfg Config, jobTypes []string) (*Supervisor, error) {
	specs := map[string]LaunchSpec{}
	for _, jobType := range jobTypes {
		spec, err := launchSpecFromEnv(jobType)
		if err != nil {
			return nil, err
		}
		if spec != nil {
			specs[jobType] = *spec
		}
	}
	if len(specs) == 0 {
		return nil, nil
	}
	log.Printf("on-demand launch enabled: %v (exclusive=%v)", sortedKeys(specs), cfg.Exclusive)
	return &Supervisor{specs: specs, exclusive: cfg.Exclusive, stopGrace: cfg.StopGrace}, nil
}

func NewSupervisor(specs map[string]LaunchSpec, exclusive bool, stopGrace time.Duration) *Supervisor {
	return &Supervisor{specs: specs, exclusive: exclusive, stopGrace: stopGrace}
}

func (s *Supervisor) ManagedTypes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	types := make([]string, 0, len(s.specs))
	for jobType := range s.specs {
		types = append(types, jobType)
	}
	sort.Strings(types)
	return types
}

func (s *Supervisor) Manages(jobType string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.specs[jobType]
	return ok
}

func (s *Supervisor) Current() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running == nil {
		return ""
	}
	return s.running.spec.Type
}

func (s *Supervisor) Touch(jobType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running != nil && s.running.spec.Type == jobType {
		s.running.lastUsed = time.Now()
	}
}

func (s *Supervisor) Ensure(jobType string, probe func() bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	spec, managed := s.specs[jobType]
	if !managed {
		return probe()
	}
	if s.running != nil && s.running.spec.Type == jobType {
		if s.aliveLocked(s.running) {
			if probe() {
				s.running.lastUsed = time.Now()
				return true
			}
			return false
		}
		log.Printf("%s service exited; restarting", jobType)
		s.teardownLocked()
	}
	if s.running != nil && s.exclusive {
		log.Printf("stopping %s before starting %s to free the GPU", s.running.spec.Type, jobType)
		s.teardownLocked()
	}
	return s.launchLocked(spec, probe)
}

func (s *Supervisor) ReapIdle() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running == nil || s.running.spec.IdleTimeout <= 0 || time.Since(s.running.lastUsed) < s.running.spec.IdleTimeout {
		return ""
	}
	jobType := s.running.spec.Type
	log.Printf("%s idle for %.0fs; stopping", jobType, time.Since(s.running.lastUsed).Seconds())
	s.teardownLocked()
	return jobType
}

func (s *Supervisor) StopAll() { s.mu.Lock(); defer s.mu.Unlock(); s.teardownLocked() }

func (s *Supervisor) aliveLocked(running *runningService) bool {
	if running.process == nil {
		return true
	}
	select {
	case <-running.done:
		return false
	default:
		return true
	}
}

func (s *Supervisor) launchLocked(spec LaunchSpec, probe func() bool) bool {
	log.Printf("starting %s: %s", spec.Type, spec.Command)
	cmd := platformShellCommand(spec.Command)
	cmd.Dir = spec.CWD
	cmd.Env = os.Environ()
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	prepareProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("could not start %s: %v", spec.Type, err)
		return false
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	tracked := cmd
	var trackedDone <-chan struct{} = done
	if spec.StopCommand != "" {
		tracked = nil
		trackedDone = nil
	}
	now := time.Now()
	s.running = &runningService{spec: spec, process: tracked, done: trackedDone, started: now, lastUsed: now}
	if !sleepWhileAlive(spec.Warmup, trackedDone) {
		log.Printf("%s exited during warmup", spec.Type)
		s.running = nil
		return false
	}
	deadline := time.Now().Add(spec.ReadyTimeout)
	for time.Now().Before(deadline) {
		if trackedDone != nil && channelClosed(trackedDone) {
			log.Printf("%s exited before becoming ready", spec.Type)
			s.running = nil
			return false
		}
		if probe() {
			log.Printf("%s ready after %.0fs", spec.Type, time.Since(now).Seconds())
			s.running.lastUsed = time.Now()
			return true
		}
		if !sleepWhileAlive(2*time.Second, trackedDone) {
			log.Printf("%s exited before becoming ready", spec.Type)
			s.running = nil
			return false
		}
	}
	log.Printf("%s did not become ready within %s", spec.Type, spec.ReadyTimeout)
	s.teardownLocked()
	return false
}

func channelClosed(done <-chan struct{}) bool {
	if done == nil {
		return false
	}
	select {
	case <-done:
		return true
	default:
		return false
	}
}

func sleepWhileAlive(duration time.Duration, done <-chan struct{}) bool {
	if duration <= 0 {
		return !channelClosed(done)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	if done == nil {
		<-timer.C
		return true
	}
	select {
	case <-timer.C:
		return true
	case <-done:
		return false
	}
}

func (s *Supervisor) teardownLocked() {
	running := s.running
	s.running = nil
	if running == nil {
		return
	}
	if running.spec.StopCommand != "" {
		log.Printf("stopping %s: %s", running.spec.Type, running.spec.StopCommand)
		ctx, cancel := context.WithTimeout(context.Background(), s.stopGrace)
		defer cancel()
		cmd := platformShellCommandContext(ctx, running.spec.StopCommand)
		cmd.Dir = running.spec.CWD
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		if err := cmd.Run(); err != nil {
			log.Printf("stop command for %s failed: %v", running.spec.Type, err)
		}
		_ = ctx
		return
	}
	cmd := running.process
	if cmd == nil || channelClosed(running.done) {
		return
	}
	log.Printf("stopping %s (pid %d)", running.spec.Type, cmd.Process.Pid)
	if err := terminateProcessGroup(cmd, false); err != nil {
		log.Printf("could not terminate %s cleanly: %v", running.spec.Type, err)
	}
	select {
	case <-running.done:
	case <-time.After(s.stopGrace):
		log.Printf("%s did not stop cleanly; killing", running.spec.Type)
		_ = terminateProcessGroup(cmd, true)
		select {
		case <-running.done:
		case <-time.After(10 * time.Second):
			log.Printf("%s still did not exit", running.spec.Type)
		}
	}
}
