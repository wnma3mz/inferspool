package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type PermanentError struct{ Message string }

func (e *PermanentError) Error() string { return e.Message }

func permanentError(format string, args ...any) error {
	return &PermanentError{Message: fmt.Sprintf(format, args...)}
}

func requireString(payload map[string]any, names ...string) (string, error) {
	for _, name := range names {
		if value, exists := payload[name]; exists && value != nil {
			text := fmt.Sprint(value)
			if text != "" {
				return text, nil
			}
		}
	}
	return "", permanentError("payload has none of: %s", strings.Join(names, ", "))
}

type Handler func(context.Context, Job, *BatchContext, ServiceHealth) (map[string]any, error)

type Handlers struct {
	cfg    Config
	queue  *QueueClient
	http   *http.Client
	direct *DirectResultServer
	byType map[string]Handler
}

func newHandlers(cfg Config, queue *QueueClient, registry *ServiceRegistry, direct *DirectResultServer) *Handlers {
	h := &Handlers{cfg: cfg, queue: queue, http: &http.Client{}, direct: direct, byType: map[string]Handler{}}
	for _, jobType := range registry.Types() {
		switch jobType {
		case "llm":
			h.byType[jobType] = h.runLLM
		case "image":
			h.byType[jobType] = h.runImage
		case "video":
			h.byType[jobType] = h.runVideo
		case "tts":
			h.byType[jobType] = h.runTTS
		}
	}
	return h
}

func resultDelivery(job Job) string {
	if value, ok := job.Payload["_result_delivery"].(string); ok && value == "direct" {
		return "direct"
	}
	return "cloud"
}

func (h *Handlers) deliverResult(ctx context.Context, job Job, filename, mime string, content []byte) (map[string]any, error) {
	if resultDelivery(job) == "direct" {
		result, err := h.direct.Publish(filename, mime, content)
		if err == nil && logLevelEnabled(h.cfg.LogLevel, "INFO") {
			log.Printf("result delivered job=%.8s delivery=direct filename=%q content_type=%q bytes=%d",
				job.ID, filename, mime, len(content))
		}
		return result, err
	}
	result, err := h.queue.UploadResult(ctx, job.ID, filename, mime, content)
	if err == nil && logLevelEnabled(h.cfg.LogLevel, "INFO") {
		log.Printf("result delivered job=%.8s delivery=cloud filename=%q content_type=%q bytes=%d",
			job.ID, filename, mime, len(content))
	}
	return result, err
}

func compressImage(content []byte) ([]byte, string, string) {
	image, err := png.Decode(bytes.NewReader(content))
	if err != nil {
		return content, "image/png", ".png"
	}
	bounds := image.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, alpha := image.At(x, y).RGBA()
			if alpha != 0xffff {
				return content, "image/png", ".png"
			}
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image, &jpeg.Options{Quality: 88}); err != nil || encoded.Len() >= len(content) {
		return content, "image/png", ".png"
	}
	return encoded.Bytes(), "image/jpeg", ".jpg"
}

func (h *Handlers) request(ctx context.Context, method, target string, body any, timeout time.Duration) (*http.Response, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			cancel()
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(requestCtx, method, target, reader)
	if err != nil {
		cancel()
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.http.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r *cancelReadCloser) Close() error { err := r.ReadCloser.Close(); r.cancel(); return err }

func backendModel(health ServiceHealth) string {
	if len(health.Models) > 0 {
		return health.Models[0]
	}
	return "default"
}

func numberValue(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case json.Number:
		n, _ := typed.Float64()
		return n
	case string:
		n, err := strconv.ParseFloat(typed, 64)
		if err == nil {
			return n
		}
	}
	return fallback
}

func (h *Handlers) runLLM(ctx context.Context, job Job, batch *BatchContext, health ServiceHealth) (map[string]any, error) {
	prompt, err := requireString(job.Payload, "prompt", "text")
	if err != nil {
		return nil, err
	}
	if err := batch.Check(job.ID, floatPtr(.05), stringPtr("submitted")); err != nil {
		return nil, err
	}
	maxTokens := int(numberValue(job.Payload["max_tokens"], 1024))
	if maxTokens < 1 {
		maxTokens = 1
	}
	var content any = prompt
	if rawImages, ok := job.Payload["images"].([]any); ok && len(rawImages) > 0 {
		parts := []map[string]any{{"type": "text", "text": prompt}}
		for _, raw := range rawImages {
			encoded, err := json.Marshal(raw)
			if err != nil {
				return nil, permanentError("invalid input image: %v", err)
			}
			var image InputImage
			if err := json.Unmarshal(encoded, &image); err != nil {
				return nil, permanentError("invalid input image: %v", err)
			}
			url, err := h.queue.InputURL(ctx, job.ID, image)
			if err != nil {
				return nil, err
			}
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}})
		}
		content = parts
	}
	body := map[string]any{
		"model":       backendModel(health),
		"messages":    []map[string]any{{"role": "user", "content": content}},
		"max_tokens":  maxTokens,
		"temperature": numberValue(job.Payload["temperature"], .7),
		"stream":      true,
	}
	requestData, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	target := health.BaseURL + "/v1/chat/completions"
	started := logBackendRequest(h.cfg.LogLevel, job.ID, "llm", http.MethodPost, target, "application/json", requestData)
	resp, err := h.request(ctx, http.MethodPost, health.BaseURL+"/v1/chat/completions", body, h.cfg.RequestTime)
	if err != nil {
		logBackendResponse(h.cfg.LogLevel, job.ID, "llm", 0, "", nil, started, err)
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		err := fmt.Errorf("llm HTTP %d: %.200s", resp.StatusCode, data)
		logBackendResponse(h.cfg.LogLevel, job.ID, "llm", resp.StatusCode, resp.Header.Get("Content-Type"), data, started, fmt.Errorf("HTTP %d", resp.StatusCode))
		return nil, err
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	var output strings.Builder
	chunks := 0
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var event struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &event) != nil || len(event.Choices) == 0 || event.Choices[0].Delta.Content == "" {
			continue
		}
		output.WriteString(event.Choices[0].Delta.Content)
		chunks++
		fraction := min(.95, .05+float64(chunks)/float64(maxTokens))
		message := output.String()
		if len(message) > 80 {
			message = message[len(message)-80:]
		}
		if err := batch.Check(job.ID, &fraction, &message); err != nil {
			return nil, err
		}
	}
	if err := scanner.Err(); err != nil {
		logBackendResponse(h.cfg.LogLevel, job.ID, "llm", resp.StatusCode, "application/json", []byte(output.String()), started, err)
		return nil, err
	}
	if output.Len() == 0 {
		err := errors.New("llm returned no content")
		logBackendResponse(h.cfg.LogLevel, job.ID, "llm", resp.StatusCode, "application/json", nil, started, err)
		return nil, err
	}
	responseData, _ := json.Marshal(map[string]any{"text": output.String(), "model": body["model"], "chunks": chunks})
	logBackendResponse(h.cfg.LogLevel, job.ID, "llm", resp.StatusCode, "application/json", responseData, started, nil)
	return map[string]any{"text": output.String(), "model": body["model"], "chunks": chunks}, nil
}

func copyPayloadFields(dst, src map[string]any, fields ...string) {
	for _, field := range fields {
		if value, ok := src[field]; ok && value != nil {
			dst[field] = value
		}
	}
}

// jobRequest keeps checking the batch while a synchronous Omni request runs.
// Canceling a task closes the HTTP request, which also stops server generation.
func (h *Handlers) jobRequest(ctx context.Context, job Job, batch *BatchContext, service, method, target, contentType string, body []byte) (status int, headers http.Header, data []byte, resultErr error) {
	started := logBackendRequest(h.cfg.LogLevel, job.ID, service, method, target, contentType, body)
	defer func() {
		responseType := ""
		if headers != nil {
			responseType = headers.Get("Content-Type")
		}
		logBackendResponse(h.cfg.LogLevel, job.ID, service, status, responseType, data, started, resultErr)
	}()
	requestCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTime)
	jobError := make(chan error, 1)
	done := make(chan struct{})
	defer func() { close(done); cancel() }()
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-requestCtx.Done():
				return
			case <-ticker.C:
				if err := batch.Check(job.ID, nil, nil); err != nil {
					jobError <- err
					cancel()
					return
				}
			}
		}
	}()
	req, err := http.NewRequestWithContext(requestCtx, method, target, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := h.http.Do(req)
	if err != nil {
		select {
		case jobErr := <-jobError:
			return 0, nil, nil, jobErr
		default:
			return 0, nil, nil, err
		}
	}
	defer resp.Body.Close()
	data, err = io.ReadAll(resp.Body)
	if err != nil {
		select {
		case jobErr := <-jobError:
			return 0, nil, nil, jobErr
		default:
			return 0, nil, nil, err
		}
	}
	if err := batch.Check(job.ID, nil, nil); err != nil {
		return 0, nil, nil, err
	}
	return resp.StatusCode, resp.Header.Clone(), data, nil
}

func omniError(service string, status int, data []byte) error {
	if status == http.StatusBadRequest || status == http.StatusUnprocessableEntity {
		return permanentError("%s rejected the request: %.300s", service, data)
	}
	return fmt.Errorf("%s HTTP %d: %.300s", service, status, data)
}

func (h *Handlers) runImage(ctx context.Context, job Job, batch *BatchContext, health ServiceHealth) (map[string]any, error) {
	prompt, err := requireString(job.Payload, "prompt")
	if err != nil {
		return nil, err
	}
	body := map[string]any{"prompt": prompt, "model": backendModel(health), "response_format": "b64_json"}
	copyPayloadFields(body, job.Payload, "n", "size", "negative_prompt", "num_inference_steps", "guidance_scale", "true_cfg_scale", "seed")
	requestData, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if err := batch.Check(job.ID, floatPtr(.1), stringPtr("generating image")); err != nil {
		return nil, err
	}
	status, _, responseData, err := h.jobRequest(ctx, job, batch, "image", http.MethodPost, health.BaseURL+"/v1/images/generations", "application/json", requestData)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, omniError("image", status, responseData)
	}
	var response struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseData, &response); err != nil {
		return nil, fmt.Errorf("image response: %w", err)
	}
	if len(response.Data) == 0 {
		return nil, errors.New("image service returned no images")
	}
	files := make([]map[string]any, 0, len(response.Data))
	for index, item := range response.Data {
		content, err := base64.StdEncoding.DecodeString(item.Base64)
		if err != nil {
			return nil, fmt.Errorf("image %d has invalid base64: %w", index+1, err)
		}
		content, mimeType, extension := compressImage(content)
		uploaded, err := h.deliverResult(ctx, job, fmt.Sprintf("image-%d%s", index+1, extension), mimeType, content)
		if err != nil {
			return nil, err
		}
		uploaded["kind"] = "images"
		files = append(files, uploaded)
	}
	return map[string]any{"files": files, "type": "image"}, nil
}

func (h *Handlers) runVideo(ctx context.Context, job Job, batch *BatchContext, health ServiceHealth) (map[string]any, error) {
	prompt, err := requireString(job.Payload, "prompt")
	if err != nil {
		return nil, err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]any{"prompt": prompt, "model": backendModel(health)}
	copyPayloadFields(fields, job.Payload, "seconds", "size", "width", "height", "num_frames", "fps", "num_inference_steps", "guidance_scale", "true_cfg_scale", "seed", "negative_prompt", "generate_sound")
	for name, value := range fields {
		if err := writer.WriteField(name, fmt.Sprint(value)); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if err := batch.Check(job.ID, floatPtr(.1), stringPtr("generating video")); err != nil {
		return nil, err
	}
	status, headers, content, err := h.jobRequest(ctx, job, batch, "video", http.MethodPost, health.BaseURL+"/v1/videos/sync", writer.FormDataContentType(), body.Bytes())
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, omniError("video", status, content)
	}
	mimeType := strings.TrimSpace(strings.Split(headers.Get("Content-Type"), ";")[0])
	if !strings.HasPrefix(mimeType, "video/") {
		mimeType = "video/mp4"
	}
	extension := extensionForMIME(mimeType, ".mp4")
	uploaded, err := h.deliverResult(ctx, job, "video"+extension, mimeType, content)
	if err != nil {
		return nil, err
	}
	return map[string]any{"file": uploaded, "type": "video"}, nil
}

func (h *Handlers) runTTS(ctx context.Context, job Job, batch *BatchContext, health ServiceHealth) (map[string]any, error) {
	text, err := requireString(job.Payload, "text", "prompt")
	if err != nil {
		return nil, err
	}
	if err := batch.Check(job.ID, floatPtr(.1), stringPtr("synthesizing")); err != nil {
		return nil, err
	}
	body := map[string]any{"input": text, "model": backendModel(health), "response_format": "opus"}
	copyPayloadFields(body, job.Payload, "voice", "response_format", "speed", "task_type", "language", "instructions", "max_new_tokens", "ref_audio", "ref_text", "x_vector_only_mode", "non_streaming_mode")
	requestData, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	status, headers, content, err := h.jobRequest(ctx, job, batch, "tts", http.MethodPost, health.BaseURL+"/v1/audio/speech", "application/json", requestData)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, omniError("tts", status, content)
	}
	if err := batch.Check(job.ID, floatPtr(.9), stringPtr("encoding")); err != nil {
		return nil, err
	}
	contentType := strings.TrimSpace(strings.Split(headers.Get("Content-Type"), ";")[0])
	if contentType == "application/octet-stream" {
		contentType = "audio/wav"
	}
	if !strings.HasPrefix(contentType, "audio/") {
		return nil, fmt.Errorf("tts returned unexpected content-type: %s", contentType)
	}
	extension := extensionForMIME(contentType, ".wav")
	uploaded, err := h.deliverResult(ctx, job, "speech"+extension, contentType, content)
	if err != nil {
		return nil, err
	}
	return map[string]any{"file": uploaded, "type": "tts"}, nil
}

func extensionForMIME(mimeType, fallback string) string {
	if mimeType == "audio/mpeg" {
		return ".mp3"
	}
	extensions, _ := mime.ExtensionsByType(mimeType)
	if len(extensions) > 0 {
		return extensions[0]
	}
	return fallback
}

func floatPtr(value float64) *float64 { return &value }
func stringPtr(value string) *string  { return &value }
