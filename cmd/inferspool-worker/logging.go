package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"
)

const backendLogBodyLimit = 4096

func logLevelEnabled(configured, wanted string) bool {
	levels := map[string]int{"DEBUG": 0, "INFO": 1, "WARN": 2, "ERROR": 3}
	return levels[configured] <= levels[wanted]
}

func backendPath(target string) string {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Path == "" {
		return "<invalid>"
	}
	return parsed.Path
}

func sensitiveLogKey(key string) bool {
	key = strings.ToLower(key)
	for _, part := range []string{"authorization", "token", "secret", "password", "api_key", "apikey", "signed_url"} {
		if strings.Contains(key, part) {
			return true
		}
	}
	return key == "url" || strings.HasSuffix(key, "_url")
}

func sanitizeLogValue(value any, key string, depth int) any {
	if sensitiveLogKey(key) {
		return "[redacted]"
	}
	if depth > 8 {
		return "[depth omitted]"
	}
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for childKey, child := range typed {
			if childKey == "b64_json" {
				if text, ok := child.(string); ok {
					out[childKey] = fmt.Sprintf("[base64 omitted: %d chars]", len(text))
				} else {
					out[childKey] = "[base64 omitted]"
				}
				continue
			}
			out[childKey] = sanitizeLogValue(child, childKey, depth+1)
		}
		return out
	case []any:
		limit := min(len(typed), 20)
		out := make([]any, 0, limit+1)
		for _, child := range typed[:limit] {
			out = append(out, sanitizeLogValue(child, "", depth+1))
		}
		if len(typed) > limit {
			out = append(out, fmt.Sprintf("[%d items omitted]", len(typed)-limit))
		}
		return out
	case string:
		if len(typed) > 512 {
			return typed[:512] + fmt.Sprintf("...[truncated, %d chars total]", len(typed))
		}
		return typed
	default:
		return value
	}
}

func sanitizedJSON(data []byte) string {
	if len(data) == 0 {
		return "null"
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Sprintf("[non-JSON omitted: %d bytes]", len(data))
	}
	clean, err := json.Marshal(sanitizeLogValue(value, "", 0))
	if err != nil {
		return fmt.Sprintf("[unavailable: %d bytes]", len(data))
	}
	if len(clean) > backendLogBodyLimit {
		return string(clean[:backendLogBodyLimit]) + fmt.Sprintf("...[truncated, %d bytes total]", len(clean))
	}
	return string(clean)
}

func logBackendRequest(level, jobID, service, method, target, contentType string, body []byte) time.Time {
	started := time.Now()
	if logLevelEnabled(level, "INFO") {
		log.Printf("backend request job=%.8s service=%s method=%s path=%s content_type=%q bytes=%d",
			jobID, service, method, backendPath(target), contentType, len(body))
	}
	if logLevelEnabled(level, "DEBUG") {
		log.Printf("backend request body job=%.8s service=%s body=%s", jobID, service, sanitizedJSON(body))
	}
	return started
}

func logBackendResponse(level, jobID, service string, status int, contentType string, body []byte, started time.Time, err error) {
	if logLevelEnabled(level, "INFO") {
		log.Printf("backend response job=%.8s service=%s status=%d content_type=%q bytes=%d duration_ms=%d error=%q",
			jobID, service, status, contentType, len(body), time.Since(started).Milliseconds(), err)
	}
	if !logLevelEnabled(level, "DEBUG") {
		return
	}
	preview := sanitizedJSON(body)
	if !strings.Contains(strings.ToLower(contentType), "json") {
		preview = fmt.Sprintf("[binary omitted: %d bytes]", len(body))
	}
	log.Printf("backend response body job=%.8s service=%s body=%s", jobID, service, preview)
}
