package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func client() (*Client, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	return NewClient(cfg)
}

// buildPayload assembles the request body from the prompt plus optional flags.
func buildPayload(jobType, text string, f flags) (map[string]any, error) {
	payload := map[string]any{}
	if f.payload != "" {
		if err := json.Unmarshal([]byte(f.payload), &payload); err != nil {
			return nil, fmt.Errorf("--payload is not valid JSON: %w", err)
		}
	}
	payload[promptField(jobType)] = text
	if f.voice != "" {
		if jobType != "tts" {
			return nil, fmt.Errorf("--voice is only supported for tts tasks")
		}
		payload["voice"] = f.voice
	}
	setFloat := func(flag, value, field string, min, max float64, types ...string) error {
		if value == "" {
			return nil
		}
		if !contains(types, jobType) {
			return fmt.Errorf("--%s is not supported for %s tasks", flag, jobType)
		}
		n, err := strconv.ParseFloat(value, 64)
		if err != nil || n < min || n > max {
			return fmt.Errorf("--%s must be between %g and %g", flag, min, max)
		}
		payload[field] = n
		return nil
	}
	setInt := func(flag, value, field string, min, max int, types ...string) error {
		if value == "" {
			return nil
		}
		if !contains(types, jobType) {
			return fmt.Errorf("--%s is not supported for %s tasks", flag, jobType)
		}
		n, err := strconv.Atoi(value)
		if err != nil || n < min || n > max {
			return fmt.Errorf("--%s must be between %d and %d", flag, min, max)
		}
		payload[field] = n
		return nil
	}
	if err := setFloat("temperature", f.temperature, "temperature", 0, 2, "llm"); err != nil {
		return nil, err
	}
	if err := setInt("max-tokens", f.maxTokens, "max_tokens", 1, 131072, "llm"); err != nil {
		return nil, err
	}
	if err := setInt("steps", f.steps, "num_inference_steps", 1, 200, "image", "video"); err != nil {
		return nil, err
	}
	if err := setFloat("seconds", f.seconds, "seconds", .01, 300, "video"); err != nil {
		return nil, err
	}
	if err := setInt("fps", f.fps, "fps", 1, 240, "video"); err != nil {
		return nil, err
	}
	if err := setFloat("speed", f.speed, "speed", .25, 4, "tts"); err != nil {
		return nil, err
	}
	if f.size != "" {
		if !contains([]string{"image", "video"}, jobType) {
			return nil, fmt.Errorf("--size is not supported for %s tasks", jobType)
		}
		parts := strings.Split(f.size, "x")
		if len(parts) != 2 {
			return nil, fmt.Errorf("--size must look like 1024x1024")
		}
		width, e1 := strconv.Atoi(parts[0])
		height, e2 := strconv.Atoi(parts[1])
		if e1 != nil || e2 != nil || width < 32 || height < 32 || width > 32768 || height > 32768 {
			return nil, fmt.Errorf("--size is out of range")
		}
		payload["size"] = f.size
	}
	if f.format != "" {
		if jobType != "tts" || !contains([]string{"wav", "mp3", "flac", "pcm", "opus"}, f.format) {
			return nil, fmt.Errorf("--format must be wav, mp3, flac, pcm, or opus for tts")
		}
		payload["response_format"] = f.format
	}
	if len(f.images) > 0 && jobType != "llm" {
		return nil, fmt.Errorf("--image is only supported for llm tasks")
	}
	return payload, nil
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func cmdSubmit(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) == 0 {
		return 1, fmt.Errorf("submit needs a type (image video tts llm)")
	}

	jobType := f.rest[0]
	if !jobTypes[jobType] {
		return 1, fmt.Errorf("unknown type %q", jobType)
	}

	text := strings.Join(f.rest[1:], " ")
	if f.stdin || text == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return 1, err
		}
		text = strings.TrimSpace(string(data))
	}
	if text == "" {
		return 1, fmt.Errorf("nothing to submit; pass text or use --stdin")
	}

	payload, err := buildPayload(jobType, text, f)
	if err != nil {
		return 1, err
	}

	c, err := client()
	if err != nil {
		return 1, err
	}
	if len(f.images) > 0 {
		refs := make([]InputImage, 0, len(f.images))
		for _, source := range f.images {
			image, err := c.PrepareInputImage(source)
			if err != nil {
				return 1, err
			}
			refs = append(refs, image)
		}
		payload["images"] = refs
	}

	job, err := c.Submit(jobType, payload, f.priority, f.key)
	if err != nil {
		return 1, err
	}

	if !f.wait {
		fmt.Println(job.ID)
		return 0, nil
	}

	final, err := waitFor(c, job.ID, f)
	if err != nil {
		return 1, err
	}
	return emitResult(final, f.jsonOut, c), nil
}

func cmdBatch(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) < 2 {
		return 1, fmt.Errorf("batch needs a type and a file (\"-\" for stdin)")
	}

	jobType, path := f.rest[0], f.rest[1]
	if !jobTypes[jobType] {
		return 1, fmt.Errorf("unknown type %q", jobType)
	}

	var reader io.Reader = os.Stdin
	if path != "-" {
		fh, err := os.Open(path)
		if err != nil {
			return 1, err
		}
		defer fh.Close()
		reader = fh
	}

	c, err := client()
	if err != nil {
		return 1, err
	}

	// Streamed rather than slurped, so a huge prompt file is not held in memory.
	var ids []string
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		payload, err := buildPayload(jobType, line, f)
		if err != nil {
			return 1, err
		}
		job, err := c.Submit(jobType, payload, f.priority,
			batchKey(jobType, line, f.tag))
		if err != nil {
			return 1, err
		}
		ids = append(ids, job.ID)
		fmt.Println(job.ID)
	}
	if err := scanner.Err(); err != nil {
		return 1, err
	}
	if len(ids) == 0 {
		return 1, fmt.Errorf("no input lines")
	}

	if !f.wait {
		return 0, nil
	}

	fmt.Fprintf(os.Stderr, "waiting for %d job(s)…\n", len(ids))
	failed := 0
	for _, id := range ids {
		job, err := waitFor(c, id, flags{quiet: true, timeout: f.timeout})
		if err != nil {
			return 1, err
		}
		if job.Status != "succeeded" {
			failed++
		}
		fmt.Fprintf(os.Stderr, "%s %s\n", id[:8], colorStatus(job.Status))
	}
	if failed > 0 {
		return 1, nil
	}
	return 0, nil
}

func cmdList(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	c, err := client()
	if err != nil {
		return 1, err
	}

	page, err := c.List(ListOptions{Limit: f.limit, Status: f.status, Type: f.jobType,
		Search: f.search, Before: f.before, After: f.after, Tag: f.filterTag, Cursor: f.cursor})
	if err != nil {
		return 1, err
	}
	jobs := page.Data

	if f.jsonOut {
		// An empty result must marshal as [], not null: scripts pipe this
		// straight into jq.
		if jobs == nil {
			jobs = []Job{}
		}
		fmt.Println(mustJSON(jobs))
		return 0, nil
	}
	if len(jobs) == 0 {
		fmt.Println("no jobs")
		return 0, nil
	}
	for _, job := range jobs {
		printJobLine(job)
	}
	if page.NextCursor != nil {
		fmt.Fprintf(os.Stderr, "next cursor: %s\n", *page.NextCursor)
	}
	return 0, nil
}

func cmdGet(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) == 0 {
		return 1, fmt.Errorf("get needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}

	job, err := c.Get(f.rest[0])
	if err != nil {
		return 1, err
	}
	if job.ID == "" {
		return 1, fmt.Errorf("job %s not found", f.rest[0])
	}

	// `get` is a query, so the exit code reports whether the job FAILED, not
	// whether it has finished. A queued job has not failed, so it exits 0.
	if f.jsonOut {
		fmt.Println(mustJSON(job))
		if job.Status == "failed" || job.Status == "canceled" {
			return 1, nil
		}
		return 0, nil
	}
	if job.Terminal() {
		return emitResult(job, false, c), nil
	}
	printJobLine(job)
	return 0, nil
}

func cmdWatch(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) == 0 {
		return 1, fmt.Errorf("watch needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}

	job, err := waitFor(c, f.rest[0], f)
	if err != nil {
		return 1, err
	}
	return emitResult(job, f.jsonOut, c), nil
}

func cmdCancel(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) == 0 {
		return 1, fmt.Errorf("cancel needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}

	status, err := c.Cancel(f.rest[0])
	if err != nil {
		return 1, err
	}
	fmt.Printf("%s %s\n", f.rest[0][:min(8, len(f.rest[0]))], status)
	return 0, nil
}

func cmdRetry(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) != 1 {
		return 1, fmt.Errorf("retry needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}
	job, err := c.Retry(f.rest[0])
	if err != nil {
		return 1, err
	}
	if f.jsonOut {
		fmt.Println(mustJSON(job))
	} else {
		fmt.Println(job.ID)
	}
	return 0, nil
}

func cmdDelete(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) != 1 {
		return 1, fmt.Errorf("delete needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}
	if err := c.Delete(f.rest[0]); err != nil {
		return 1, err
	}
	fmt.Println("deletion requested")
	return 0, nil
}

func cmdKeep(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	if len(f.rest) != 1 {
		return 1, fmt.Errorf("keep needs a job id")
	}
	c, err := client()
	if err != nil {
		return 1, err
	}
	if err := c.Keep(f.rest[0], !f.unkeep); err != nil {
		return 1, err
	}
	if f.unkeep {
		fmt.Println("default retention restored")
	} else {
		fmt.Println("result kept")
	}
	return 0, nil
}

// cmdStatus shows what the GPU side is currently able to serve — the same
// information the web UI displays.
func cmdStatus(args []string) (int, error) {
	f, err := parseFlags(args)
	if err != nil {
		return 1, err
	}
	c, err := client()
	if err != nil {
		return 1, err
	}

	stats, err := c.Stats()
	if err != nil {
		return 1, err
	}

	if f.jsonOut {
		fmt.Println(mustJSON(stats))
		return 0, nil
	}

	fmt.Printf("%d worker(s) online · %d queued · %d running\n\n",
		stats.WorkersOnline, stats.Queued, stats.Running)

	if len(stats.Services) == 0 {
		fmt.Println("no services registered")
		return 0, nil
	}

	types := make([]string, 0, len(stats.Services))
	for t := range stats.Services {
		types = append(types, t)
	}
	sort.Strings(types)

	fmt.Printf("%-8s %-10s %-8s %s\n", "TYPE", "BACKENDS", "SLOTS", "QUEUED")
	for _, t := range types {
		s := stats.Services[t]
		state := fmt.Sprintf("%d/%d", s.Up, s.Total)
		if s.Up == 0 {
			state = colorize(state, "31") // red: nothing can run
		} else {
			state = colorize(state, "32")
		}
		fmt.Printf("%-8s %-19s %-8d %d\n", t, state, s.Capacity, s.Queued)
	}

	// Exit non-zero when work is queued but nothing can run it, so scripts can
	// detect "my GPU box is down".
	for _, s := range stats.Services {
		if s.Queued > 0 && s.Up == 0 {
			return 1, nil
		}
	}
	return 0, nil
}

func cmdConfig(args []string) (int, error) {
	if len(args) == 0 {
		return 1, fmt.Errorf("config needs an action: set-key <key>")
	}

	action := args[0]
	if action == "advanced" {
		return cmdAdvancedConfig(args[1:])
	}
	if action != "set-key" {
		return 1, fmt.Errorf("unknown config action %q", action)
	}
	if len(args) < 2 {
		return 1, fmt.Errorf("set-key needs a value")
	}
	if err := saveConfig(func(c *Config) { c.APIKey = args[1] }); err != nil {
		return 1, err
	}
	fmt.Printf("saved key to %s\n", configPath())
	return 0, nil
}

// cmdAdvancedConfig is only for switching to a self-hosted inferspool server.
func cmdAdvancedConfig(args []string) (int, error) {
	if len(args) == 0 {
		return 1, fmt.Errorf("advanced config needs an action (show, set-url)")
	}

	action := args[0]
	if action == "show" {
		cfg, err := loadConfig()
		if err != nil {
			return 1, err
		}
		fmt.Printf("%-9s %s\n", "server", orUnset(cfg.ServerURL))
		fmt.Printf("%-9s %s\n", "api_key", redact(cfg.APIKey))
		fmt.Printf("\n%-9s %s\n", "config", configPath())
		return 0, nil
	}

	if len(args) < 2 {
		return 1, fmt.Errorf("%s needs a value", action)
	}
	value := args[1]

	var err error
	switch action {
	case "set-url":
		err = saveConfig(func(c *Config) { c.ServerURL = value })
	default:
		return 1, fmt.Errorf("unknown advanced config action %q", action)
	}
	if err != nil {
		return 1, err
	}
	fmt.Printf("saved %s to %s\n", strings.TrimPrefix(action, "set-"),
		configPath())
	return 0, nil
}

func orUnset(s string) string {
	if s == "" {
		return "(unset)"
	}
	return s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// waitFor polls until the job reaches a terminal state, drawing progress on a
// single rewritten line.
func waitFor(c *Client, id string, f flags) (Job, error) {
	spinner := []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
	frame := 0
	live := isTTY(os.Stderr) && !f.quiet
	deadline := time.Time{}
	if d := waitTimeout(f); d > 0 {
		deadline = time.Now().Add(d)
	}

	for {
		job, err := c.Get(id)
		if err != nil {
			return job, err
		}
		if job.ID == "" {
			return job, fmt.Errorf("job %s not found", id)
		}
		if job.Terminal() {
			if live {
				fmt.Fprint(os.Stderr, "\r\033[K")
			}
			return job, nil
		}

		if !deadline.IsZero() && time.Now().After(deadline) {
			if live {
				fmt.Fprint(os.Stderr, "\r\033[K")
			}
			return job, fmt.Errorf("timed out after %ds waiting for %s "+
				"(still %s)", f.timeout, id[:8], job.Status)
		}

		if live {
			line := fmt.Sprintf("%c %s", spinner[frame%len(spinner)], job.Status)
			if job.Progress != nil {
				line += fmt.Sprintf(" %.0f%%", *job.Progress*100)
			}
			if job.ProgressMsg != nil && *job.ProgressMsg != "" {
				msg := strings.ReplaceAll(*job.ProgressMsg, "\n", " ")
				if len(msg) > 60 {
					msg = msg[len(msg)-60:]
				}
				line += " " + msg
			}
			fmt.Fprint(os.Stderr, "\r\033[K"+line)
			frame++
		}

		time.Sleep(2 * time.Second)
	}
}
