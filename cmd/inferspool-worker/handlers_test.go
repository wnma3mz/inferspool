package main

import "testing"

func TestBackendModelComesFromGPUService(t *testing.T) {
	health := ServiceHealth{Models: []string{"gpu-selected-model", "another-model"}}
	if got := backendModel(health); got != "gpu-selected-model" {
		t.Fatalf("backendModel() = %q, want GPU service model", got)
	}
	if got := backendModel(ServiceHealth{}); got != "default" {
		t.Fatalf("backendModel() without advertised models = %q, want default", got)
	}
}
