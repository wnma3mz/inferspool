package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

func main() { os.Exit(runCLI(os.Args[1:])) }

func usage() {
	fmt.Fprintf(os.Stderr, `inferspool-worker — run and diagnose the home GPU worker

Usage:
  inferspool-worker run [--env-file PATH]
  inferspool-worker doctor [--env-file PATH] [--json]
  inferspool-worker status [--env-file PATH] [--json]
  inferspool-worker version
`)
}

func parseCommand(name string, args []string) (string, bool, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	envFile := fs.String("env-file", "", "load environment from PATH")
	jsonOut := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return "", false, err
	}
	if fs.NArg() != 0 {
		return "", false, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	return *envFile, *jsonOut, nil
}

func runCLI(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}
	if args[0] == "version" {
		fmt.Println(version)
		return 0
	}
	if args[0] != "run" && args[0] != "doctor" && args[0] != "status" {
		usage()
		return 2
	}
	envFile, jsonOut, err := parseCommand(args[0], args[1:])
	if err != nil {
		return 2
	}
	if err := loadEnvFile(envFile); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	specs := buildSpecs(cfg)
	if len(specs) == 0 {
		fmt.Fprintln(os.Stderr, "no services configured")
		return 2
	}
	registry := NewServiceRegistry(specs)
	registry.EnableDirectResults(cfg.DirectURL != "")
	switch args[0] {
	case "status":
		return commandStatus(context.Background(), registry, jsonOut)
	case "doctor":
		return commandDoctor(context.Background(), cfg, registry, jsonOut)
	case "run":
		if err := cfg.validateServer(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		return commandRun(cfg, registry)
	}
	return 2
}

func commandStatus(ctx context.Context, registry *ServiceRegistry, jsonOut bool) int {
	healths := registry.CheckAll(ctx, true)
	if jsonOut {
		data, _ := json.MarshalIndent(healths, "", "  ")
		fmt.Println(string(data))
	} else {
		for _, h := range healths {
			state := "down"
			detail := h.Detail
			if h.Healthy {
				state = "ready"
				detail = strings.Join(h.Models, ", ")
			}
			fmt.Printf("%-8s %-7s capacity=%d %s\n", h.Type, state, h.Capacity, detail)
		}
	}
	for _, h := range healths {
		if !h.Healthy {
			return 1
		}
	}
	return 0
}

type doctorCheck struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Detail string `json:"detail"`
}

func commandDoctor(ctx context.Context, cfg Config, registry *ServiceRegistry, jsonOut bool) int {
	checks := []doctorCheck{}
	if err := cfg.validateServer(); err != nil {
		checks = append(checks, doctorCheck{"configuration", "fail", err.Error()})
	} else {
		client := NewQueueClient(cfg)
		if _, err := client.PendingByType(ctx); err != nil {
			checks = append(checks, doctorCheck{"worker authentication", "fail", err.Error()})
		} else {
			checks = append(checks, doctorCheck{"worker authentication", "ok", cfg.WorkerID})
		}
		if err := client.CheckUploadEndpoint(ctx); err != nil {
			checks = append(checks, doctorCheck{"result upload", "fail", err.Error()})
		} else {
			checks = append(checks, doctorCheck{"result upload", "ok", "signing endpoint reachable"})
		}
	}
	for _, h := range registry.CheckAll(ctx, true) {
		state := "fail"
		detail := h.Detail
		if h.Healthy {
			state = "ok"
			detail = strings.Join(h.Models, ", ")
		}
		checks = append(checks, doctorCheck{h.Type + " backend", state, detail})
	}
	sort.Slice(checks, func(i, j int) bool { return checks[i].Name < checks[j].Name })
	if jsonOut {
		data, _ := json.MarshalIndent(checks, "", "  ")
		fmt.Println(string(data))
	} else {
		for _, c := range checks {
			fmt.Printf("%-20s %-4s %s\n", c.Name, c.State, c.Detail)
		}
	}
	for _, c := range checks {
		if c.State == "fail" {
			return 1
		}
	}
	return 0
}

func commandRun(cfg Config, registry *ServiceRegistry) int {
	client := NewQueueClient(cfg)
	direct := NewDirectResultServer(cfg)
	if err := direct.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = direct.Close(ctx)
	}()
	handlers := newHandlers(cfg, client, registry, direct)
	supervisor, err := buildSupervisor(cfg, registry.Types())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	runner := NewRunner(cfg, client, registry, supervisor, handlers.byType)

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		first := <-signals
		fmt.Fprintf(os.Stderr, "signal %s: draining current batch\n", first)
		runner.Shutdown()
		if second, ok := <-signals; ok {
			fmt.Fprintf(os.Stderr, "second signal %s: exiting immediately\n", second)
			os.Exit(1)
		}
	}()

	runner.Run(context.Background())
	return 0
}
