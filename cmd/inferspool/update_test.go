package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestChecksumManifestAndArtifactName(t *testing.T) {
	got, err := checksumFor([]byte("abc123  inferspool-linux-amd64\n"), "inferspool-linux-amd64")
	if err != nil || got != "abc123" {
		t.Fatalf("got=%q err=%v", got, err)
	}
	name, err := releaseArtifact()
	if err != nil {
		t.Fatal(err)
	}
	want := "inferspool-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if name != want {
		t.Fatalf("name=%q want=%q", name, want)
	}
}

func TestReleaseBaseMustBeConfigured(t *testing.T) {
	old := defaultReleaseBase
	defaultReleaseBase = ""
	t.Cleanup(func() { defaultReleaseBase = old })
	t.Setenv("INFERSPOOL_RELEASE_URL", "")
	if _, err := releaseBase(); err == nil || !strings.Contains(err.Error(), "no update source") {
		t.Fatalf("expected missing update source, got %v", err)
	}
	t.Setenv("INFERSPOOL_RELEASE_URL", "https://releases.example.test/")
	got, err := releaseBase()
	if err != nil || got != "https://releases.example.test" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestUpdateCheckAndChecksumValidation(t *testing.T) {
	artifact, err := releaseArtifact()
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte("new inferspool binary")
	sum := sha256.Sum256(binary)
	manifest := hex.EncodeToString(sum[:]) + "  " + artifact + "\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch strings.TrimPrefix(r.URL.Path, "/") {
		case "VERSION":
			_, _ = w.Write([]byte("99.0.0\n"))
		case "SHA256SUMS":
			_, _ = w.Write([]byte(manifest))
		case artifact:
			_, _ = w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("INFERSPOOL_RELEASE_URL", server.URL)
	oldVersion := version
	version = "1.0.0"
	t.Cleanup(func() { version = oldVersion })

	output := capture(t, func() {
		code, checkErr := cmdUpdate([]string{"--check"})
		if checkErr != nil || code != 0 {
			t.Fatalf("code=%d err=%v", code, checkErr)
		}
	})
	if !strings.Contains(output, "1.0.0 -> 99.0.0") {
		t.Fatalf("unexpected output %q", output)
	}
	got, err := verifiedReleaseBinary(server.Client(), artifact)
	if err != nil || string(got) != string(binary) {
		t.Fatalf("verified binary=%q err=%v", got, err)
	}

	manifest = strings.Repeat("0", 64) + "  " + artifact + "\n"
	if _, err := verifiedReleaseBinary(server.Client(), artifact); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}

func TestReplaceExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows cannot replace a running executable; covered by release smoke tests")
	}
	path := filepath.Join(t.TempDir(), "inferspool")
	if err := os.WriteFile(path, []byte("old"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := replaceExecutable(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "new" {
		t.Fatalf("content=%q err=%v", got, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0751 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
}
