package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDirectResultServerServesUntilExpiry(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := "http://" + listener.Addr().String()
	direct := &DirectResultServer{
		baseURL: address, ttl: time.Minute, files: map[string]directResult{}, stop: make(chan struct{}),
	}
	direct.server = &http.Server{Handler: direct}
	go direct.server.Serve(listener)
	t.Cleanup(func() { _ = direct.Close(context.Background()) })

	result, err := direct.Publish("result.txt", "text/plain", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	url := result["url"].(string)
	for i := 0; i < 2; i++ {
		response, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || string(body) != "hello" {
			t.Fatalf("request %d: status=%d body=%q", i, response.StatusCode, body)
		}
	}
}

func TestDirectResultServerExpiresContent(t *testing.T) {
	direct := &DirectResultServer{baseURL: "http://worker.local:9090", ttl: time.Millisecond, files: map[string]directResult{}}
	result, err := direct.Publish("result.txt", "text/plain", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	direct.prune()
	if len(direct.files) != 0 || direct.bytes != 0 {
		t.Fatalf("expired result retained: files=%d bytes=%d url=%v", len(direct.files), direct.bytes, result["url"])
	}
}

func TestDirectResultServerExpiredRequestReleasesBuffer(t *testing.T) {
	direct := &DirectResultServer{
		files: map[string]directResult{
			"expired": {content: []byte("hello"), expires: time.Now().Add(-time.Second)},
		},
		bytes: 5,
	}
	request := httptest.NewRequest(http.MethodGet, "/result/expired", nil)
	response := httptest.NewRecorder()
	direct.ServeHTTP(response, request)

	if response.Code != http.StatusGone {
		t.Fatalf("status=%d, want %d", response.Code, http.StatusGone)
	}
	if len(direct.files) != 0 || direct.bytes != 0 {
		t.Fatalf("expired request retained buffer: files=%d bytes=%d", len(direct.files), direct.bytes)
	}
}

func TestDirectResultServerAllowsBrowserRangePreflight(t *testing.T) {
	direct := &DirectResultServer{files: map[string]directResult{}}
	request := httptest.NewRequest(http.MethodOptions, "/result/token", nil)
	request.Header.Set("Access-Control-Request-Headers", "range")
	response := httptest.NewRecorder()
	direct.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d, want %d", response.Code, http.StatusNoContent)
	}
	if got := response.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Range") {
		t.Fatalf("allow headers=%q, want Range", got)
	}
}
