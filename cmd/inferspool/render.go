package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// colorEnabled is false when piped or when NO_COLOR is set, so output stays
// parseable in scripts.
var colorEnabled = isTTY(os.Stdout) && os.Getenv("NO_COLOR") == ""

func isTTY(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func colorize(s, code string) string {
	if !colorEnabled {
		return s
	}
	return "\033[" + code + "m" + s + "\033[0m"
}

var statusColor = map[string]string{
	"queued":    "90",
	"running":   "36",
	"succeeded": "32",
	"failed":    "31",
	"canceled":  "33",
}

func colorStatus(status string) string {
	return colorize(status, statusColor[status])
}

func stageLabel(job Job) string {
	labels := map[string]string{
		"waiting_for_worker":        "waiting for GPU",
		"waiting_for_service":       "waiting for model service",
		"waiting_for_capacity":      "waiting for capacity",
		"waiting_for_direct_worker": "waiting for direct-capable GPU",
		"assigned":                  "assigned",
		"generating":                "generating",
		"encoding":                  "encoding",
		"delivering":                "delivering",
	}
	if label := labels[job.Stage]; label != "" {
		return label
	}
	return job.Status
}

func printJobLine(job Job) {
	pct := ""
	if job.Progress != nil && job.Status == "running" {
		pct = fmt.Sprintf(" %3.0f%%", *job.Progress*100)
	}

	// Pad before colorizing: escape codes would break column alignment.
	status := fmt.Sprintf("%-25s", stageLabel(job))
	if colorEnabled {
		status = colorize(status, statusColor[job.Status])
	}

	fmt.Printf("%s  %s %-6s%-5s %s\n", job.ID[:8], status, job.Type, pct,
		job.Describe())
}

// emitResult prints a finished job and returns the process exit code, so the
// shell can branch on whether the job succeeded.
func emitResult(job Job, asJSON bool, clients ...*Client) int {
	if asJSON {
		fmt.Println(mustJSON(job))
		if job.Status == "succeeded" {
			return 0
		}
		return 1
	}

	if job.Status != "succeeded" {
		msg := "no error recorded"
		if job.Error != nil && *job.Error != "" {
			msg = *job.Error
		}
		fmt.Fprintf(os.Stderr, "%s: %s\n", job.Status, msg)
		return 1
	}

	if len(clients) > 0 && clients[0] != nil {
		job = signResultFiles(job, clients[0])
	}
	printResult(job)
	return 0
}

func signResultFiles(job Job, client *Client) Job {
	var result map[string]any
	if json.Unmarshal(job.Result, &result) != nil {
		return job
	}
	sign := func(file map[string]any) {
		bucket, _ := file["bucket"].(string)
		path, _ := file["path"].(string)
		if bucket == "" || path == "" {
			return
		}
		if url, err := client.ResultURL(job.ID, bucket, path); err == nil {
			file["url"] = url
		}
	}
	if artifacts, ok := result["artifacts"].([]any); ok {
		for _, value := range artifacts {
			if file, ok := value.(map[string]any); ok {
				sign(file)
			}
		}
	}
	if files, ok := result["files"].([]any); ok {
		for _, value := range files {
			if file, ok := value.(map[string]any); ok {
				sign(file)
			}
		}
	}
	if file, ok := result["file"].(map[string]any); ok {
		sign(file)
	}
	if data, err := json.Marshal(result); err == nil {
		job.Result = data
	}
	return job
}

// printResult shows the useful part of a result without dumping megabytes of
// base64 into the terminal.
func printResult(job Job) {
	var result map[string]any
	if err := json.Unmarshal(job.Result, &result); err != nil || result == nil {
		fmt.Println(string(job.Result))
		return
	}

	// Text-shaped results print directly.
	if text, ok := result["text"].(string); ok && text != "" {
		fmt.Println(text)
		return
	}
	if key, ok := result["key"].(string); ok && key != "" {
		fmt.Println(key)
		return
	}

	// Artifact-shaped multimedia results print one path per line. Legacy
	// file/files fields remain readable for jobs created before the migration.
	if artifacts, ok := result["artifacts"].([]any); ok && len(artifacts) > 0 {
		printFiles(artifacts)
		return
	}
	if files, ok := result["files"].([]any); ok && len(files) > 0 {
		printFiles(files)
		return
	}
	if file, ok := result["file"].(map[string]any); ok {
		if url, _ := file["url"].(string); url != "" {
			fmt.Println(url)
			return
		}
		if path, _ := file["path"].(string); path != "" {
			fmt.Println(path)
			return
		}
	}

	// Otherwise summarise, replacing any large inline blob with its size. A raw
	// dump here would flood the terminal with base64.
	summary := map[string]any{}
	for k, v := range result {
		if s, ok := v.(string); ok && len(s) > 256 {
			summary[k] = fmt.Sprintf("<%d bytes, use --json to see it>", len(s))
			continue
		}
		if arr, ok := v.([]any); ok && len(arr) > 8 {
			summary[k] = fmt.Sprintf("<%d items, use --json to see them>", len(arr))
			continue
		}
		summary[k] = v
	}
	fmt.Println(mustJSON(summary))
}

func printFiles(files []any) {
	for _, value := range files {
		file, ok := value.(map[string]any)
		if !ok {
			continue
		}
		name, _ := file["url"].(string)
		if name == "" {
			name, _ = file["path"].(string)
		}
		if name == "" {
			name, _ = file["filename"].(string)
		}
		sub, _ := file["subfolder"].(string)
		if sub != "" {
			name = sub + "/" + name
		}
		fmt.Println(name)
	}
}
