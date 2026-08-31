package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Job mirrors the jobs table. Payload and Result stay as raw JSON because their
// shape is per job type.
type Job struct {
	ID          string          `json:"id"`
	UserID      string          `json:"user_id"`
	Type        string          `json:"type"`
	Status      string          `json:"status"`
	Priority    int             `json:"priority"`
	Payload     json.RawMessage `json:"payload"`
	Result      json.RawMessage `json:"result"`
	Progress    *float64        `json:"progress"`
	ProgressMsg *string         `json:"progress_msg"`
	Error       *string         `json:"error"`
	Attempts    int             `json:"attempts"`
	MaxAttempts int             `json:"max_attempts"`
	CreatedAt   time.Time       `json:"created_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
	SourceJobID *string         `json:"source_job_id"`
	KeepResult  bool            `json:"keep_result"`
	Tags        []string        `json:"tags"`
}

func (j Job) Terminal() bool {
	switch j.Status {
	case "succeeded", "failed", "canceled":
		return true
	}
	return false
}

// Describe returns a short label for a list row.
func (j Job) Describe() string {
	var p struct {
		Prompt string `json:"prompt"`
		Text   string `json:"text"`
	}
	_ = json.Unmarshal(j.Payload, &p)
	s := p.Prompt
	if s == "" {
		s = p.Text
	}
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 48 {
		return s[:47] + "…"
	}
	return s
}

// ServiceStat is the per-type backend summary shown by `inferspool status`.
type ServiceStat struct {
	Up       int `json:"up"`
	Total    int `json:"total"`
	Capacity int `json:"capacity"`
	Queued   int `json:"queued"`
}

type QueueStats struct {
	Queued        int                    `json:"queued"`
	Running       int                    `json:"running"`
	WorkersOnline int                    `json:"workers_online"`
	Services      map[string]ServiceStat `json:"services"`
}

type InputImage struct {
	URL      string `json:"url,omitempty"`
	Bucket   string `json:"bucket,omitempty"`
	Path     string `json:"path,omitempty"`
	Mime     string `json:"mime,omitempty"`
	Filename string `json:"filename,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
}

var errAuth = errors.New("invalid or revoked API key")

type Client struct {
	baseURL    string
	gatewayKey string
	apiKey     string
	http       *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	var missing []string
	if cfg.ServerURL == "" {
		missing = append(missing, "server URL (INFERSPOOL_URL)")
	}
	if cfg.gatewayKey == "" {
		missing = append(missing, "internal gateway configuration")
	}
	if cfg.APIKey == "" {
		missing = append(missing, "API key (run `inferspool login <email>` or set INFERSPOOL_API_KEY)")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing config: %s", strings.Join(missing, ", "))
	}

	return &Client{
		baseURL:    strings.TrimRight(cfg.ServerURL, "/") + "/v1",
		gatewayKey: cfg.gatewayKey,
		apiKey:     cfg.APIKey,
		http:       &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) ResultURL(jobID, bucket, path string) (string, error) {
	body, err := json.Marshal(map[string]string{
		"bucket": bucket, "path": path,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST",
		c.baseURL+"/jobs/"+url.PathEscape(jobID)+"/result", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("result URL failed: %s", data)
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.URL, nil
}

func (c *Client) PrepareInputImage(source string) (InputImage, error) {
	if parsed, err := url.Parse(source); err == nil && parsed.IsAbs() {
		if parsed.Scheme != "https" {
			return InputImage{}, errors.New("remote images must use HTTPS")
		}
		return InputImage{URL: source}, nil
	}
	file, err := os.Open(source)
	if err != nil {
		return InputImage{}, fmt.Errorf("open image: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return InputImage{}, err
	}
	if info.Size() > 20<<20 {
		return InputImage{}, errors.New("image must be 20 MB or smaller")
	}
	content, err := io.ReadAll(io.LimitReader(file, 20<<20+1))
	if err != nil {
		return InputImage{}, err
	}
	mimeType := http.DetectContentType(content)
	allowed := map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true}
	if !allowed[mimeType] {
		return InputImage{}, fmt.Errorf("unsupported image type: %s", mimeType)
	}
	body, _ := json.Marshal(map[string]string{"filename": filepath.Base(source), "content_type": mimeType})
	req, _ := http.NewRequest(http.MethodPost, c.baseURL+"/inputs", bytes.NewReader(body))
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return InputImage{}, err
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if readErr != nil {
		return InputImage{}, readErr
	}
	if resp.StatusCode >= 400 {
		return InputImage{}, fmt.Errorf("sign input upload HTTP %d: %.300s", resp.StatusCode, data)
	}
	var target struct {
		Bucket, Path, Mime, Filename string
		SignedURL                    string `json:"signed_url"`
	}
	if err := json.Unmarshal(data, &target); err != nil {
		return InputImage{}, err
	}
	put, _ := http.NewRequest(http.MethodPut, target.SignedURL, bytes.NewReader(content))
	put.Header.Set("Content-Type", mimeType)
	put.Header.Set("x-upsert", "false")
	uploaded, err := c.http.Do(put)
	if err != nil {
		return InputImage{}, err
	}
	defer uploaded.Body.Close()
	if uploaded.StatusCode >= 400 {
		return InputImage{}, fmt.Errorf("input upload HTTP %d", uploaded.StatusCode)
	}
	return InputImage{Bucket: target.Bucket, Path: target.Path, Mime: mimeType, Filename: filepath.Base(source), Bytes: info.Size()}, nil
}

func (c *Client) request(method, path string, input any, out any) error {
	var reader io.Reader
	if input != nil {
		body, err := json.Marshal(input)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("apikey", c.gatewayKey)
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode >= 400 {
		text := string(data)
		// Match on the SQLSTATE we raise, not on message text.
		if strings.Contains(text, "28000") || strings.Contains(text, "invalid api key") {
			return errAuth
		}
		if len(text) > 300 {
			text = text[:300]
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, text)
	}

	if out == nil || len(data) == 0 || string(data) == "null" {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *Client) Submit(jobType string, payload map[string]any, priority int,
	idempotencyKey string) (Job, error) {
	var job Job
	params := map[string]any{
		"type":     jobType,
		"payload":  payload,
		"priority": priority,
	}
	if idempotencyKey != "" {
		params["idempotency_key"] = idempotencyKey
	}
	err := c.request(http.MethodPost, "/jobs", params, &job)
	return job, err
}

func (c *Client) Get(id string) (Job, error) {
	var job Job
	err := c.request(http.MethodGet, "/jobs/"+url.PathEscape(id), nil, &job)
	return job, err
}

type ListOptions struct {
	Limit                                            int
	Status, Type, Search, Before, After, Tag, Cursor string
}

type JobPage struct {
	Data       []Job   `json:"data"`
	NextCursor *string `json:"next_cursor"`
}

func (c *Client) List(options ListOptions) (JobPage, error) {
	var page JobPage
	query := url.Values{}
	query.Set("limit", fmt.Sprint(options.Limit))
	for key, value := range map[string]string{"status": options.Status, "type": options.Type, "search": options.Search, "before": options.Before, "after": options.After, "tag": options.Tag, "cursor": options.Cursor} {
		if value != "" {
			query.Set(key, value)
		}
	}
	err := c.request(http.MethodGet, "/jobs?"+query.Encode(), nil, &page)
	return page, err
}

func (c *Client) Cancel(id string) (string, error) {
	var result struct {
		Status string `json:"status"`
	}
	err := c.request(http.MethodPost, "/jobs/"+url.PathEscape(id)+"/cancel", map[string]any{}, &result)
	if err != nil {
		return "", err
	}
	return result.Status, nil
}

func (c *Client) Retry(id string) (Job, error) {
	var job Job
	err := c.request(http.MethodPost, "/jobs/"+url.PathEscape(id)+"/retry", map[string]any{}, &job)
	return job, err
}

func (c *Client) Delete(id string) error {
	return c.request(http.MethodDelete, "/jobs/"+url.PathEscape(id), nil, nil)
}

func (c *Client) Keep(id string, keep bool) error {
	return c.request(http.MethodPost, "/jobs/"+url.PathEscape(id)+"/keep", map[string]bool{"keep": keep}, nil)
}

// Stats takes no arguments: queue_stats is readable anonymously and returns no
// identifying detail to unauthenticated callers.
func (c *Client) Stats() (QueueStats, error) {
	var stats QueueStats
	err := c.request(http.MethodGet, "/status", nil, &stats)
	return stats, err
}
