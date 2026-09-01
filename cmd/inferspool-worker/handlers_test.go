package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestBackendModelComesFromGPUService(t *testing.T) {
	health := ServiceHealth{Models: []string{"gpu-selected-model", "another-model"}}
	if got := backendModel(health); got != "gpu-selected-model" {
		t.Fatalf("backendModel() = %q, want GPU service model", got)
	}
	if got := backendModel(ServiceHealth{}); got != "default" {
		t.Fatalf("backendModel() without advertised models = %q, want default", got)
	}
}

func TestSanitizedJSONRedactsSecretsAndLargePayloads(t *testing.T) {
	raw := []byte(`{"prompt":"hello","token":"secret","image_url":{"url":"https://signed.example/private"},"data":[{"b64_json":"abcdefgh"}]}`)
	got := sanitizedJSON(raw)
	for _, secret := range []string{"secret", "signed.example", "abcdefgh"} {
		if strings.Contains(got, secret) {
			t.Fatalf("sanitized log leaked %q: %s", secret, got)
		}
	}
	for _, wanted := range []string{"hello", "[redacted]", "[base64 omitted: 8 chars]"} {
		if !strings.Contains(got, wanted) {
			t.Fatalf("sanitized log missing %q: %s", wanted, got)
		}
	}
}

func TestSanitizedJSONTruncatesWholeRecord(t *testing.T) {
	items := make([]any, 20)
	for i := range items {
		items[i] = strings.Repeat("x", 512)
	}
	raw, _ := json.Marshal(map[string]any{"items": items})
	got := sanitizedJSON(raw)
	if len(got) < backendLogBodyLimit || !strings.Contains(got, "truncated") {
		t.Fatalf("expected bounded log record, got %d bytes", len(got))
	}
}

func TestBackendPathDropsHostAndQuery(t *testing.T) {
	got := backendPath("https://secret.example/v1/images/generations?token=secret")
	if got != "/v1/images/generations" {
		t.Fatalf("backendPath()=%q", got)
	}
}

func TestCompressImageNeverIncreasesSize(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	value := uint32(1)
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			value = value*1664525 + 1013904223
			img.Set(x, y, color.RGBA{uint8(value >> 24), uint8(value >> 16), uint8(value >> 8), 255})
		}
	}
	var source bytes.Buffer
	if err := png.Encode(&source, img); err != nil {
		t.Fatal(err)
	}
	compressed, mime, extension := compressImage(source.Bytes())
	if len(compressed) > source.Len() {
		t.Fatalf("compression grew from %d to %d", source.Len(), len(compressed))
	}
	if mime != "image/jpeg" || extension != ".jpg" {
		t.Fatalf("expected compressible PNG to become JPEG, got %s %s", mime, extension)
	}
}
