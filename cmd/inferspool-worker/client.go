package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var (
	ErrLeaseLost = errors.New("lease lost")
	ErrAuth      = errors.New("worker credentials rejected")
)

type Job struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Payload     map[string]any `json:"payload"`
	Attempts    int            `json:"attempts"`
	MaxAttempts int            `json:"max_attempts"`
}

type QueueAPI interface {
	PendingByType(context.Context) (map[string]int, error)
	ReportServices(context.Context, []ServiceHealth) error
	Claim(context.Context, string, int, int) ([]Job, error)
	Heartbeat(context.Context, []string, int) (map[string]bool, map[string]bool, error)
	Progress(context.Context, []ProgressUpdate) error
	Complete(context.Context, string, map[string]any) error
	Fail(context.Context, string, string, bool) error
}

type InputImage struct {
	URL      string `json:"url,omitempty"`
	Bucket   string `json:"bucket,omitempty"`
	Path     string `json:"path,omitempty"`
	Mime     string `json:"mime,omitempty"`
	Filename string `json:"filename,omitempty"`
}

type QueueClient struct {
	baseURL, gatewayKey, workerID, token string
	http                                 *http.Client
}

func NewQueueClient(c Config) *QueueClient {
	return &QueueClient{baseURL: c.ServerURL, gatewayKey: c.gatewayKey,
		workerID: c.WorkerID, token: c.WorkerToken,
		http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *QueueClient) rpc(ctx context.Context, fn string, params map[string]any, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	routes := map[string]string{
		"pending_by_type": "pending", "report_services": "services",
		"claim_jobs": "claim", "heartbeat_batch": "heartbeat",
		"progress_batch": "progress", "complete_job": "complete", "fail_job": "fail",
	}
	route, ok := routes[fn]
	if !ok {
		return fmt.Errorf("unknown worker operation %s", fn)
	}
	product := map[string]any{}
	for key, value := range params {
		product[strings.TrimPrefix(key, "p_")] = value
	}
	body, err := json.Marshal(product)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/workers/"+route, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("X-Worker-ID", c.workerID)
	req.Header.Set("X-Worker-Token", c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		text := string(data)
		if resp.StatusCode == http.StatusUnauthorized || strings.Contains(text, "28000") {
			return fmt.Errorf("%w: %s", ErrAuth, fn)
		}
		if resp.StatusCode == http.StatusConflict || strings.Contains(text, "P0002") || strings.Contains(strings.ToLower(text), "lease") {
			return fmt.Errorf("%w: %s", ErrLeaseLost, fn)
		}
		return fmt.Errorf("%s: HTTP %d: %.300s", fn, resp.StatusCode, text)
	}
	if out == nil || len(data) == 0 || string(data) == "null" {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *QueueClient) PendingByType(ctx context.Context) (map[string]int, error) {
	var rows []struct {
		Type string      `json:"type"`
		N    json.Number `json:"n"`
	}
	if err := c.rpc(ctx, "pending_by_type", nil, &rows); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, row := range rows {
		n, _ := row.N.Int64()
		out[row.Type] = int(n)
	}
	return out, nil
}

func (c *QueueClient) ReportServices(ctx context.Context, services []ServiceHealth) error {
	return c.rpc(ctx, "report_services", map[string]any{"p_services": services}, nil)
}

func (c *QueueClient) Claim(ctx context.Context, jobType string, limit, leaseSecs int) ([]Job, error) {
	var rows []Job
	err := c.rpc(ctx, "claim_jobs", map[string]any{"p_types": []string{jobType},
		"p_limit": limit, "p_lease_secs": leaseSecs}, &rows)
	return rows, err
}

func (c *QueueClient) Heartbeat(ctx context.Context, ids []string, leaseSecs int) (map[string]bool, map[string]bool, error) {
	var rows []struct {
		ID     string `json:"id"`
		Cancel bool   `json:"cancel_requested"`
	}
	if len(ids) == 0 {
		return map[string]bool{}, map[string]bool{}, nil
	}
	if err := c.rpc(ctx, "heartbeat_batch", map[string]any{"p_job_ids": ids,
		"p_lease_secs": leaseSecs}, &rows); err != nil {
		return nil, nil, err
	}
	renewed, canceled := map[string]bool{}, map[string]bool{}
	for _, row := range rows {
		renewed[row.ID] = true
		if row.Cancel {
			canceled[row.ID] = true
		}
	}
	lost := map[string]bool{}
	for _, id := range ids {
		if !renewed[id] {
			lost[id] = true
		}
	}
	return canceled, lost, nil
}

type ProgressUpdate struct {
	ID       string   `json:"id"`
	Progress *float64 `json:"progress,omitempty"`
	Message  *string  `json:"msg,omitempty"`
}

func (c *QueueClient) Progress(ctx context.Context, updates []ProgressUpdate) error {
	if len(updates) == 0 {
		return nil
	}
	return c.rpc(ctx, "progress_batch", map[string]any{"p_updates": updates}, nil)
}
func (c *QueueClient) Complete(ctx context.Context, id string, result map[string]any) error {
	return c.rpc(ctx, "complete_job", map[string]any{"p_job_id": id, "p_result": result}, nil)
}
func (c *QueueClient) Fail(ctx context.Context, id, message string, retryable bool) error {
	if len(message) > 2000 {
		message = message[:2000]
	}
	return c.rpc(ctx, "fail_job", map[string]any{"p_job_id": id,
		"p_error": message, "p_retryable": retryable}, nil)
}

func (c *QueueClient) UploadResult(ctx context.Context, jobID, filename, mime string, content []byte) (map[string]any, error) {
	payload, _ := json.Marshal(map[string]string{"job_id": jobID, "filename": filename, "content_type": mime})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/workers/results/upload", bytes.NewReader(payload))
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("X-Worker-ID", c.workerID)
	req.Header.Set("X-Worker-Token", c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode >= 400 {
		if resp.StatusCode == 409 || strings.Contains(strings.ToLower(string(data)), "lease") {
			return nil, ErrLeaseLost
		}
		return nil, fmt.Errorf("sign upload HTTP %d: %.300s", resp.StatusCode, data)
	}
	var target struct {
		Bucket, Path string
		SignedURL    string `json:"signed_url"`
	}
	if err := json.Unmarshal(data, &target); err != nil {
		return nil, err
	}
	put, _ := http.NewRequestWithContext(ctx, http.MethodPut, target.SignedURL, bytes.NewReader(content))
	put.Header.Set("Content-Type", mime)
	put.Header.Set("x-upsert", "false")
	uploaded, err := c.http.Do(put)
	if err != nil {
		return nil, err
	}
	defer uploaded.Body.Close()
	if uploaded.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(uploaded.Body, 4096))
		return nil, fmt.Errorf("upload HTTP %d: %s", uploaded.StatusCode, b)
	}
	return map[string]any{"bucket": target.Bucket, "path": target.Path, "delivery": "cloud",
		"filename": filename, "mime": mime, "bytes": len(content)}, nil
}

func (c *QueueClient) CheckUploadEndpoint(ctx context.Context) error {
	_, err := c.UploadResult(ctx, "00000000-0000-0000-0000-000000000000", "doctor.txt", "text/plain", []byte("doctor"))
	if errors.Is(err, ErrLeaseLost) {
		return nil
	}
	return err
}

func (c *QueueClient) InputURL(ctx context.Context, jobID string, image InputImage) (string, error) {
	if image.URL != "" {
		return image.URL, nil
	}
	if image.Bucket == "" || image.Path == "" {
		return "", errors.New("input image requires url or bucket/path")
	}
	payload, _ := json.Marshal(map[string]string{"job_id": jobID, "bucket": image.Bucket, "path": image.Path})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/workers/inputs/download", bytes.NewReader(payload))
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("X-Worker-ID", c.workerID)
	req.Header.Set("X-Worker-Token", c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("sign input download HTTP %d: %.300s", resp.StatusCode, data)
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return "", err
	}
	if result.URL == "" {
		return "", errors.New("input download signer returned no URL")
	}
	return result.URL, nil
}
