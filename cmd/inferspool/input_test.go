package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestInputImageUsesProductPayloadFields(t *testing.T) {
	data, err := json.Marshal(InputImage{Bucket: "inputs", Path: "user/image.png", Mime: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, `"bucket":"inputs"`) || strings.Contains(text, `"Bucket"`) {
		t.Fatalf("unexpected input image JSON: %s", text)
	}
}
