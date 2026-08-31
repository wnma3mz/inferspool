package main

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// capture redirects stdout for the duration of fn.
func capture(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w

	done := make(chan string)
	go func() {
		data, _ := io.ReadAll(r)
		done <- string(data)
	}()

	fn()
	w.Close()
	os.Stdout = old
	return <-done
}

func TestPrintResultText(t *testing.T) {
	job := Job{Status: "succeeded",
		Result: json.RawMessage(`{"text":"the answer","model":"qwen"}`)}
	out := capture(t, func() { printResult(job) })
	if strings.TrimSpace(out) != "the answer" {
		t.Errorf("got %q, want just the text", out)
	}
}

func TestPrintResultFiles(t *testing.T) {
	// Image results carry a file list; print one path per line so the output
	// pipes into other tools.
	job := Job{Status: "succeeded", Result: json.RawMessage(
		`{"files":[{"filename":"a.png","subfolder":""},
		           {"filename":"b.png","subfolder":"sub"}]}`)}
	out := capture(t, func() { printResult(job) })
	lines := strings.Fields(strings.TrimSpace(out))
	if len(lines) != 2 || lines[0] != "a.png" || lines[1] != "sub/b.png" {
		t.Errorf("got %q, want two file paths", out)
	}
}

func TestPrintResultSignedFile(t *testing.T) {
	job := Job{Status: "succeeded", Result: json.RawMessage(
		`{"file":{"filename":"speech.wav","path":"u/j/speech.wav","url":"https://download.test/speech.wav"}}`)}
	out := capture(t, func() { printResult(job) })
	if strings.TrimSpace(out) != "https://download.test/speech.wav" {
		t.Errorf("got %q, want the signed URL", out)
	}
}

func TestPrintResultDoesNotDumpBase64(t *testing.T) {
	// The whole point: an inline blob must not be spewed to the terminal.
	blob := strings.Repeat("A", 100_000)
	job := Job{Status: "succeeded",
		Result: json.RawMessage(`{"mime":"audio/wav","audio_b64":"` + blob + `"}`)}

	out := capture(t, func() { printResult(job) })
	if strings.Contains(out, blob) {
		t.Error("printResult dumped the full blob to stdout")
	}
	if len(out) > 500 {
		t.Errorf("output is %d bytes; a blob should be summarised", len(out))
	}
	if !strings.Contains(out, "bytes") {
		t.Errorf("the summary should state the size, got %q", out)
	}
	// The useful metadata should survive.
	if !strings.Contains(out, "audio/wav") {
		t.Errorf("small fields should still be shown, got %q", out)
	}
}

func TestEmitResultExitCodes(t *testing.T) {
	ok := Job{Status: "succeeded", Result: json.RawMessage(`{"text":"x"}`)}
	if code := capturedEmit(t, ok, false); code != 0 {
		t.Errorf("a succeeded job should exit 0, got %d", code)
	}

	msg := "cuda oom"
	bad := Job{Status: "failed", Error: &msg, Result: json.RawMessage(`null`)}
	if code := capturedEmit(t, bad, false); code != 1 {
		t.Errorf("a failed job should exit 1, got %d", code)
	}

	cancelled := Job{Status: "canceled", Result: json.RawMessage(`null`)}
	if code := capturedEmit(t, cancelled, false); code != 1 {
		t.Errorf("a canceled job should exit 1, got %d", code)
	}
}

func capturedEmit(t *testing.T, job Job, asJSON bool) int {
	t.Helper()
	var code int
	// stderr is left alone; only the exit code matters here.
	capture(t, func() { code = emitResult(job, asJSON) })
	return code
}

func TestColorDisabledIsPlain(t *testing.T) {
	saved := colorEnabled
	colorEnabled = false
	defer func() { colorEnabled = saved }()

	if got := colorize("x", "31"); got != "x" {
		t.Errorf("colorize should be a no-op when disabled, got %q", got)
	}
	if strings.Contains(colorStatus("failed"), "\033") {
		t.Error("status should be plain when color is disabled")
	}
}
