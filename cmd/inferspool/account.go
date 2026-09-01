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
	"strings"
	"time"

	"golang.org/x/term"
)

var errLoginRequired = errors.New("not logged in; run `inferspool login <email>`")

type authResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	User         struct {
		Email string `json:"email"`
	} `json:"user"`
}

type APIKeyInfo struct {
	ID         string     `json:"id"`
	Prefix     string     `json:"prefix"`
	Label      *string    `json:"label"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

type AccountClient struct {
	cfg  Config
	http *http.Client
}

func NewAccountClient(cfg Config) *AccountClient {
	return &AccountClient{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *AccountClient) request(method, path string, body any, token string, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, strings.TrimRight(c.cfg.ServerURL, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("apikey", c.cfg.gatewayKey)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		var message struct {
			Message      string `json:"message"`
			Error        string `json:"error"`
			ErrorMessage string `json:"error_description"`
		}
		_ = json.Unmarshal(data, &message)
		detail := message.Message
		if detail == "" {
			detail = message.ErrorMessage
		}
		if detail == "" {
			detail = message.Error
		}
		if detail == "" {
			detail = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, detail)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func sessionFromAuth(response authResponse, fallbackEmail string) Session {
	email := response.User.Email
	if email == "" {
		email = fallbackEmail
	}
	return Session{
		AccessToken: response.AccessToken, RefreshToken: response.RefreshToken,
		ExpiresAt: time.Now().Add(time.Duration(response.ExpiresIn) * time.Second), Email: email,
	}
}

func (c *AccountClient) Login(email, password string) (Session, error) {
	var response authResponse
	err := c.request(http.MethodPost, "/v1/session", map[string]string{
		"email": email, "password": password,
	}, "", &response)
	if err != nil {
		return Session{}, fmt.Errorf("login failed: %w", err)
	}
	if response.AccessToken == "" || response.RefreshToken == "" {
		return Session{}, errors.New("login failed: server returned no session")
	}
	return sessionFromAuth(response, email), nil
}

func (c *AccountClient) session() (Session, error) {
	session := c.cfg.Session
	if session.Empty() {
		return Session{}, errLoginRequired
	}
	if session.AccessToken != "" && time.Until(session.ExpiresAt) > time.Minute {
		return session, nil
	}
	if session.RefreshToken == "" {
		return Session{}, errLoginRequired
	}
	var response authResponse
	if err := c.request(http.MethodPost, "/v1/session/refresh",
		map[string]string{"refresh_token": session.RefreshToken}, "", &response); err != nil {
		return Session{}, fmt.Errorf("session expired; run `inferspool login <email>`: %w", err)
	}
	refreshed := sessionFromAuth(response, session.Email)
	if err := saveConfig(func(cfg *Config) { cfg.Session = refreshed }); err != nil {
		return Session{}, err
	}
	c.cfg.Session = refreshed
	return refreshed, nil
}

func (c *AccountClient) authRequest(method, path string, body any, out any) error {
	session, err := c.session()
	if err != nil {
		return err
	}
	return c.request(method, path, body, session.AccessToken, out)
}

func (c *AccountClient) CreateKey(label string) (string, error) {
	var key string
	if err := c.authRequest(http.MethodPost, "/v1/keys",
		map[string]any{"label": nullableString(label)}, &key); err != nil {
		return "", fmt.Errorf("create API key: %w", err)
	}
	return key, nil
}

func (c *AccountClient) ListKeys() ([]APIKeyInfo, error) {
	var keys []APIKeyInfo
	path := "/v1/keys"
	if err := c.authRequest(http.MethodGet, path, nil, &keys); err != nil {
		return nil, fmt.Errorf("list API keys: %w", err)
	}
	return keys, nil
}

func (c *AccountClient) RevokeKey(id string) error {
	path := "/v1/keys/" + url.PathEscape(id)
	if err := c.authRequest(http.MethodDelete, path, nil, nil); err != nil {
		return fmt.Errorf("revoke API key: %w", err)
	}
	return nil
}

func (c *AccountClient) Logout() error {
	session, err := c.session()
	if err != nil {
		return err
	}
	return c.request(http.MethodDelete, "/v1/session", nil, session.AccessToken, nil)
}

type AccountInfo struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	Admin   bool   `json:"admin"`
	Profile struct {
		Status              string `json:"status"`
		ForcePasswordChange bool   `json:"force_password_change"`
	} `json:"profile"`
}

type WebhookInfo struct {
	ID                  string     `json:"id"`
	URL                 string     `json:"url"`
	Events              []string   `json:"events"`
	Description         *string    `json:"description"`
	ConsecutiveFailures int        `json:"consecutive_failures"`
	DisabledAt          *time.Time `json:"disabled_at"`
	CreatedAt           time.Time  `json:"created_at"`
}

type WorkerInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Services []struct {
		Type    string `json:"type"`
		Healthy bool   `json:"healthy"`
	} `json:"services"`
	DisabledAt    *time.Time `json:"disabled_at"`
	LastHeartbeat *time.Time `json:"last_heartbeat"`
}

type AdminUserInfo struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	Profile struct {
		Status string `json:"status"`
	} `json:"profile"`
}

func (c *AccountClient) Me() (AccountInfo, error) {
	var info AccountInfo
	err := c.authRequest(http.MethodGet, "/v1/me", nil, &info)
	return info, err
}

func (c *AccountClient) ChangePassword(password string) error {
	return c.authRequest(http.MethodPost, "/v1/me/password", map[string]string{"password": password}, nil)
}

func (c *AccountClient) ListWebhooks() ([]WebhookInfo, error) {
	var out []WebhookInfo
	err := c.authRequest(http.MethodGet, "/v1/webhooks", nil, &out)
	return out, err
}
func (c *AccountClient) CreateWebhook(target string, events []string, description string) (map[string]any, error) {
	var out map[string]any
	err := c.authRequest(http.MethodPost, "/v1/webhooks", map[string]any{"url": target, "events": events, "description": nullableString(description)}, &out)
	return out, err
}
func (c *AccountClient) DeleteWebhook(id string) error {
	return c.authRequest(http.MethodDelete, "/v1/webhooks/"+url.PathEscape(id), nil, nil)
}

func (c *AccountClient) AdminListWorkers() ([]WorkerInfo, error) {
	var out []WorkerInfo
	err := c.authRequest(http.MethodGet, "/v1/admin/workers", nil, &out)
	return out, err
}
func (c *AccountClient) AdminCreateWorker(id, name string) (map[string]any, error) {
	var out map[string]any
	err := c.authRequest(http.MethodPost, "/v1/admin/workers", map[string]any{"id": id, "name": name}, &out)
	return out, err
}
func (c *AccountClient) AdminWorkerAction(id, action string) (map[string]any, error) {
	var out map[string]any
	err := c.authRequest(http.MethodPost, "/v1/admin/workers/"+url.PathEscape(id)+"/"+action, map[string]any{}, &out)
	return out, err
}
func (c *AccountClient) AdminListUsers() ([]AdminUserInfo, error) {
	var page struct {
		Data []AdminUserInfo `json:"data"`
	}
	err := c.authRequest(http.MethodGet, "/v1/admin/users", nil, &page)
	return page.Data, err
}
func (c *AccountClient) AdminCreateUser(email string) (map[string]any, error) {
	var out map[string]any
	err := c.authRequest(http.MethodPost, "/v1/admin/users", map[string]string{"email": email}, &out)
	return out, err
}
func (c *AccountClient) AdminUserAction(id, action string) (map[string]any, error) {
	var out map[string]any
	err := c.authRequest(http.MethodPost, "/v1/admin/users/"+url.PathEscape(id)+"/"+action, map[string]any{}, &out)
	return out, err
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func readPassword(stdin bool) (string, error) {
	if stdin {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024))
		return strings.TrimSpace(string(data)), err
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("password input is not a terminal; use --password-stdin")
	}
	fmt.Fprint(os.Stderr, "Password: ")
	data, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	return string(data), err
}
