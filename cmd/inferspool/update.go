package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Release builds inject this from github.repository. Development/private
// builds deliberately have no guessed update source.
var defaultReleaseBase string

func releaseBase() (string, error) {
	if value := os.Getenv("INFERSPOOL_RELEASE_URL"); value != "" {
		return strings.TrimRight(value, "/"), nil
	}
	if defaultReleaseBase == "" {
		return "", errors.New("this build has no update source; set INFERSPOOL_RELEASE_URL or install an official release build")
	}
	return strings.TrimRight(defaultReleaseBase, "/"), nil
}

func releaseArtifact() (string, error) {
	switch runtime.GOOS {
	case "darwin", "linux", "windows":
	default:
		return "", fmt.Errorf("updates are not published for %s", runtime.GOOS)
	}
	switch runtime.GOARCH {
	case "amd64", "arm64":
	default:
		return "", fmt.Errorf("updates are not published for %s", runtime.GOARCH)
	}
	name := fmt.Sprintf("inferspool-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name, nil
}

func downloadRelease(client *http.Client, name string) ([]byte, error) {
	base, err := releaseBase()
	if err != nil {
		return nil, err
	}
	response, err := client.Get(base + "/" + name)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", name, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 100<<20))
	if err != nil {
		return nil, err
	}
	if len(data) == 100<<20 {
		return nil, errors.New("release artifact is unexpectedly large")
	}
	return data, nil
}

func checksumFor(manifest []byte, artifact string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(manifest)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && strings.TrimPrefix(fields[len(fields)-1], "*") == artifact {
			return strings.ToLower(fields[0]), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s is missing from SHA256SUMS", artifact)
}

func verifiedReleaseBinary(client *http.Client, artifact string) ([]byte, error) {
	manifest, err := downloadRelease(client, "SHA256SUMS")
	if err != nil {
		return nil, err
	}
	want, err := checksumFor(manifest, artifact)
	if err != nil {
		return nil, err
	}
	binary, err := downloadRelease(client, artifact)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(binary)
	if hex.EncodeToString(sum[:]) != want {
		return nil, errors.New("download checksum mismatch")
	}
	return binary, nil
}

func replaceExecutable(executable string, binary []byte) error {
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	info, err := os.Stat(executable)
	if err != nil {
		return err
	}
	temporary := executable + ".update"
	if err := os.WriteFile(temporary, binary, info.Mode().Perm()); err != nil {
		return fmt.Errorf("write update: %w", err)
	}
	defer os.Remove(temporary)
	if runtime.GOOS == "windows" {
		old := executable + ".old"
		_ = os.Remove(old)
		if err := os.Rename(executable, old); err != nil {
			return fmt.Errorf("replace current binary: %w", err)
		}
		if err := os.Rename(temporary, executable); err != nil {
			_ = os.Rename(old, executable)
			return err
		}
		return nil
	}
	if err := os.Rename(temporary, executable); err != nil {
		return fmt.Errorf("replace current binary: %w (try with permission to write %s)", err, filepath.Dir(executable))
	}
	return nil
}

func cmdUpdate(args []string) (int, error) {
	checkOnly := false
	if len(args) == 1 && args[0] == "--check" {
		checkOnly = true
	} else if len(args) != 0 {
		return 1, errorsForUsage("update only accepts --check")
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	latestData, err := downloadRelease(client, "VERSION")
	if err != nil {
		return 1, err
	}
	latest := strings.TrimSpace(string(latestData))
	if latest == "" {
		return 1, errors.New("release has no version")
	}
	if latest == version {
		fmt.Printf("inferspool %s is current\n", version)
		return 0, nil
	}
	if checkOnly {
		fmt.Printf("update available: %s -> %s\n", version, latest)
		return 0, nil
	}
	artifact, err := releaseArtifact()
	if err != nil {
		return 1, err
	}
	binary, err := verifiedReleaseBinary(client, artifact)
	if err != nil {
		return 1, err
	}
	executable, err := os.Executable()
	if err != nil {
		return 1, err
	}
	if err := replaceExecutable(executable, binary); err != nil {
		return 1, err
	}
	fmt.Printf("updated inferspool %s -> %s\n", version, latest)
	return 0, nil
}
