package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type directResult struct {
	content  []byte
	mime     string
	filename string
	expires  time.Time
}

type DirectResultServer struct {
	baseURL  string
	ttl      time.Duration
	mu       sync.Mutex
	files    map[string]directResult
	server   *http.Server
	listener net.Listener
	stop     chan struct{}
	bytes    int64
}

func NewDirectResultServer(cfg Config) *DirectResultServer {
	if cfg.DirectURL == "" {
		return nil
	}
	d := &DirectResultServer{baseURL: cfg.DirectURL, ttl: cfg.DirectTTL, files: map[string]directResult{}, stop: make(chan struct{})}
	d.server = &http.Server{Addr: cfg.DirectListen, Handler: d, ReadHeaderTimeout: 5 * time.Second}
	return d
}

func (d *DirectResultServer) Start() error {
	if d == nil {
		return nil
	}
	listener, err := net.Listen("tcp", d.server.Addr)
	if err != nil {
		return fmt.Errorf("listen for direct results: %w", err)
	}
	d.listener = listener
	go func() {
		log.Printf("direct result server listening on %s; advertised as %s", d.server.Addr, d.baseURL)
		if err := d.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("direct result server failed: %v", err)
		}
	}()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				d.prune()
			case <-d.stop:
				return
			}
		}
	}()
	return nil
}

func (d *DirectResultServer) Close(ctx context.Context) error {
	if d == nil {
		return nil
	}
	select {
	case <-d.stop:
	default:
		close(d.stop)
	}
	return d.server.Shutdown(ctx)
}

func (d *DirectResultServer) prune() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for key, value := range d.files {
		if time.Now().After(value.expires) {
			d.bytes -= int64(len(value.content))
			delete(d.files, key)
		}
	}
}

func (d *DirectResultServer) Publish(filename, mime string, content []byte) (map[string]any, error) {
	if d == nil {
		return nil, permanentError("direct result delivery requested but this worker has no direct result server")
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	d.prune()
	d.mu.Lock()
	if d.bytes+int64(len(content)) > 1<<30 {
		d.mu.Unlock()
		return nil, permanentError("direct result buffer is full; download existing results or use cloud delivery")
	}
	d.files[token] = directResult{content: content, mime: mime, filename: filename, expires: time.Now().Add(d.ttl)}
	d.bytes += int64(len(content))
	d.mu.Unlock()
	return map[string]any{
		"url": d.baseURL + "/result/" + token, "filename": filename,
		"mime": mime, "bytes": len(content), "delivery": "direct",
		"expires_at": time.Now().Add(d.ttl).UTC().Format(time.RFC3339),
	}, nil
}

func (d *DirectResultServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/result/") {
		http.NotFound(w, r)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/result/")
	d.mu.Lock()
	file, ok := d.files[token]
	if ok && time.Now().After(file.expires) {
		d.bytes -= int64(len(file.content))
		delete(d.files, token)
		ok = false
	}
	d.mu.Unlock()
	if !ok {
		http.Error(w, "result unavailable or expired", http.StatusGone)
		return
	}
	w.Header().Set("Content-Type", file.mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", file.filename))
	http.ServeContent(w, r, file.filename, time.Time{}, bytes.NewReader(file.content))
}
