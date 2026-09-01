package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type ServiceSpec struct {
	Type, BaseURL, Name, HealthPath string
	Capacity                        int
	OpenAI                          bool
}

type ServiceHealth struct {
	Type            string                    `json:"type"`
	Name            string                    `json:"name"`
	Healthy         bool                      `json:"healthy"`
	Detail          string                    `json:"detail"`
	Models          []string                  `json:"models"`
	Capacity        int                       `json:"capacity"`
	ParameterSchema map[string]ParameterRange `json:"parameter_schema"`
	BaseURL         string                    `json:"-"`
}

type ParameterRange struct {
	Type    string   `json:"type"`
	Minimum *float64 `json:"minimum,omitempty"`
	Maximum *float64 `json:"maximum,omitempty"`
	Enum    []string `json:"enum,omitempty"`
	Pattern string   `json:"pattern,omitempty"`
}

func float64Pointer(value float64) *float64 { return &value }

func parameterSchema(jobType string) map[string]ParameterRange {
	number := func(minimum, maximum float64) ParameterRange {
		return ParameterRange{Type: "number", Minimum: float64Pointer(minimum), Maximum: float64Pointer(maximum)}
	}
	integer := func(minimum, maximum float64) ParameterRange {
		return ParameterRange{Type: "integer", Minimum: float64Pointer(minimum), Maximum: float64Pointer(maximum)}
	}
	switch jobType {
	case "llm":
		return map[string]ParameterRange{"temperature": number(0, 2), "max_tokens": integer(1, 131072)}
	case "image":
		return map[string]ParameterRange{"size": {Type: "string", Pattern: `^[0-9]{2,5}x[0-9]{2,5}$`}, "num_inference_steps": integer(1, 200)}
	case "video":
		return map[string]ParameterRange{"size": {Type: "string", Pattern: `^[0-9]{2,5}x[0-9]{2,5}$`}, "num_inference_steps": integer(1, 200), "seconds": number(.01, 300), "fps": integer(1, 240)}
	case "tts":
		return map[string]ParameterRange{"voice": {Type: "string"}, "speed": number(.25, 4), "response_format": {Type: "string", Enum: []string{"wav", "mp3", "flac", "pcm", "opus"}}}
	default:
		return map[string]ParameterRange{}
	}
}

func buildSpecs(c Config) []ServiceSpec {
	var specs []ServiceSpec
	if c.LLMURL != "" {
		specs = append(specs, ServiceSpec{"llm", c.LLMURL, "vllm", "/v1/models", c.LLMCapacity, true})
	}
	if c.ImageURL != "" {
		specs = append(specs, ServiceSpec{"image", c.ImageURL, "vllm-omni", "/v1/models", c.ImageCapacity, true})
	}
	if c.VideoURL != "" {
		specs = append(specs, ServiceSpec{"video", c.VideoURL, "vllm-omni", "/v1/models", c.VideoCapacity, true})
	}
	if c.TTSURL != "" {
		specs = append(specs, ServiceSpec{"tts", c.TTSURL, "vllm-omni", "/v1/models", c.TTSCapacity, true})
	}
	return specs
}

type ServiceRegistry struct {
	mu        sync.Mutex
	specs     map[string]ServiceSpec
	cached    map[string]ServiceHealth
	cachedAt  map[string]time.Time
	backoff   map[string]time.Duration
	nextProbe map[string]time.Time
	wasOK     map[string]bool
	http      *http.Client
	direct    bool
}

func NewServiceRegistry(specs []ServiceSpec) *ServiceRegistry {
	r := &ServiceRegistry{specs: map[string]ServiceSpec{}, cached: map[string]ServiceHealth{},
		cachedAt: map[string]time.Time{}, backoff: map[string]time.Duration{},
		nextProbe: map[string]time.Time{}, wasOK: map[string]bool{},
		http: &http.Client{Timeout: 10 * time.Second}}
	for _, spec := range specs {
		spec.BaseURL = strings.TrimRight(spec.BaseURL, "/")
		r.specs[spec.Type] = spec
	}
	return r
}

func (r *ServiceRegistry) Types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	types := make([]string, 0, len(r.specs))
	for t := range r.specs {
		types = append(types, t)
	}
	sort.Strings(types)
	return types
}

func (r *ServiceRegistry) EnableDirectResults(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.direct = enabled
}

func (r *ServiceRegistry) Spec(t string) (ServiceSpec, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.specs[t]
	return s, ok
}

func (r *ServiceRegistry) CheckAll(ctx context.Context, force bool) []ServiceHealth {
	types := r.Types()
	out := make([]ServiceHealth, 0, len(types))
	for _, t := range types {
		out = append(out, r.Check(ctx, t, force))
	}
	return out
}

func (r *ServiceRegistry) Check(ctx context.Context, jobType string, force bool) ServiceHealth {
	r.mu.Lock()
	spec, ok := r.specs[jobType]
	if !ok {
		r.mu.Unlock()
		return ServiceHealth{Type: jobType, Name: jobType, Detail: "not configured"}
	}
	now := time.Now()
	if cached, exists := r.cached[jobType]; exists && !force {
		if now.Sub(r.cachedAt[jobType]) < 5*time.Second || (!cached.Healthy && now.Before(r.nextProbe[jobType])) {
			r.mu.Unlock()
			return cached
		}
	}
	r.mu.Unlock()

	health := r.probe(ctx, spec)
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, known := r.wasOK[jobType]
	if !known || previous != health.Healthy {
		if health.Healthy {
			log.Printf("%s service up: %s", jobType, spec.BaseURL)
		} else {
			log.Printf("%s service down: %s — %s", jobType, spec.BaseURL, health.Detail)
		}
	}
	r.wasOK[jobType] = health.Healthy
	r.cached[jobType] = health
	r.cachedAt[jobType] = now
	if health.Healthy {
		r.backoff[jobType] = 0
	} else {
		d := r.backoff[jobType] * 2
		if d < 2*time.Second {
			d = 2 * time.Second
		}
		if d > 60*time.Second {
			d = 60 * time.Second
		}
		r.backoff[jobType] = d
		r.nextProbe[jobType] = now.Add(d)
	}
	return health
}

func (r *ServiceRegistry) probe(ctx context.Context, spec ServiceSpec) ServiceHealth {
	h := ServiceHealth{Type: spec.Type, Name: spec.Name, Capacity: spec.Capacity, BaseURL: spec.BaseURL, Models: []string{}, ParameterSchema: parameterSchema(spec.Type)}
	deliveries := []string{"cloud"}
	if r.direct {
		deliveries = append(deliveries, "direct")
	}
	h.ParameterSchema["_result_delivery"] = ParameterRange{Type: "string", Enum: deliveries}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(probeCtx, http.MethodGet, spec.BaseURL+spec.HealthPath, nil)
	resp, err := r.http.Do(req)
	if err != nil {
		h.Detail = fmt.Sprintf("%T", err)
		return h
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		h.Detail = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return h
	}
	if spec.OpenAI {
		data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		if err != nil {
			h.Detail = err.Error()
			return h
		}
		var body map[string]any
		_ = json.Unmarshal(data, &body)
		if rows, ok := body["data"].([]any); ok {
			for _, row := range rows {
				if m, ok := row.(map[string]any); ok {
					if id, _ := m["id"].(string); id != "" {
						h.Models = append(h.Models, id)
					}
				}
			}
		}
		if len(h.Models) == 0 {
			h.Detail = "no models loaded"
			return h
		}
	}
	h.Healthy = true
	return h
}

func (r *ServiceRegistry) Capacity(jobType string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.cached[jobType]
	if !ok || !h.Healthy {
		return 0
	}
	return h.Capacity
}
func (r *ServiceRegistry) Invalidate(jobType string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cached, jobType)
	delete(r.cachedAt, jobType)
	delete(r.backoff, jobType)
	delete(r.nextProbe, jobType)
	delete(r.wasOK, jobType)
}
func (r *ServiceRegistry) Backoff() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best time.Duration
	for t, h := range r.cached {
		if !h.Healthy {
			d := time.Until(r.nextProbe[t])
			if d > 0 && (best == 0 || d < best) {
				best = d
			}
		}
	}
	return best
}
