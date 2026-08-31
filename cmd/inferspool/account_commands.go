package main

import (
	"fmt"
	"os"
	"strings"
)

func cmdLogin(args []string) (int, error) {
	passwordStdin := false
	var email string
	for _, arg := range args {
		switch arg {
		case "--password-stdin":
			passwordStdin = true
		default:
			if strings.HasPrefix(arg, "-") {
				return 1, fmt.Errorf("unknown login flag %q", arg)
			}
			if email != "" {
				return 1, errorsForUsage("login accepts one email address")
			}
			email = arg
		}
	}
	if email == "" {
		return 1, errorsForUsage("login needs an email address")
	}
	password, err := readPassword(passwordStdin)
	if err != nil {
		return 1, err
	}
	if password == "" {
		return 1, errorsForUsage("password cannot be empty")
	}

	cfg, err := loadConfig()
	if err != nil {
		return 1, err
	}
	account := NewAccountClient(cfg)
	session, err := account.Login(email, password)
	if err != nil {
		return 1, err
	}
	cfg.Session = session
	account = NewAccountClient(cfg)
	info, err := account.Me()
	if err != nil {
		return 1, err
	}
	if info.Profile.ForcePasswordChange {
		if err := saveConfig(func(saved *Config) { saved.Session = session }); err != nil {
			return 1, err
		}
		return 1, errorsForUsage("temporary password accepted; run `inferspool password` before creating an API key")
	}

	keys, err := account.ListKeys()
	if err != nil {
		return 1, err
	}
	if !configuredKeyBelongsTo(cfg.APIKey, keys) {
		key, err := account.CreateKey("CLI: " + localDeviceLabel())
		if err != nil {
			return 1, err
		}
		cfg.APIKey = key
	}
	if err := saveConfig(func(saved *Config) {
		saved.Session = session
		saved.APIKey = cfg.APIKey
	}); err != nil {
		return 1, err
	}

	fmt.Printf("logged in as %s; CLI is ready\n", session.Email)
	return 0, nil
}

func cmdLogout(args []string) (int, error) {
	if len(args) != 0 {
		return 1, errorsForUsage("logout takes no arguments")
	}
	cfg, err := loadConfig()
	if err != nil {
		return 1, err
	}
	if !cfg.Session.Empty() {
		_ = NewAccountClient(cfg).Logout()
	}
	if err := saveConfig(func(cfg *Config) {
		cfg.Session = Session{}
		cfg.APIKey = ""
	}); err != nil {
		return 1, err
	}
	fmt.Println("logged out")
	return 0, nil
}

func cmdWhoami(args []string) (int, error) {
	if len(args) != 0 {
		return 1, errorsForUsage("whoami takes no arguments")
	}
	cfg, err := loadConfig()
	if err != nil {
		return 1, err
	}
	session, err := NewAccountClient(cfg).session()
	if err != nil {
		return 1, err
	}
	fmt.Println(session.Email)
	return 0, nil
}

func cmdKey(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errorsForUsage("key needs an action (create, list, revoke)")
	}
	cfg, err := loadConfig()
	if err != nil {
		return 1, err
	}
	account := NewAccountClient(cfg)
	switch args[0] {
	case "create":
		label, err := keyCreateLabel(args[1:])
		if err != nil {
			return 1, err
		}
		key, err := account.CreateKey(label)
		if err != nil {
			return 1, err
		}
		if err := saveConfig(func(saved *Config) { saved.APIKey = key }); err != nil {
			return 1, err
		}
		fmt.Println("created and selected a new API key")
		return 0, nil
	case "list":
		if len(args) != 1 {
			return 1, errorsForUsage("key list takes no arguments")
		}
		keys, err := account.ListKeys()
		if err != nil {
			return 1, err
		}
		if len(keys) == 0 {
			fmt.Println("no active API keys")
			return 0, nil
		}
		fmt.Printf("%-36s %-22s %s\n", "ID", "KEY", "LABEL")
		for _, key := range keys {
			label := ""
			if key.Label != nil {
				label = *key.Label
			}
			selected := ""
			if keyMatchesPrefix(cfg.APIKey, key.Prefix) {
				selected = " *"
			}
			fmt.Printf("%-36s inferspool_%-11s %s%s\n", key.ID, key.Prefix+"_…", label, selected)
		}
		return 0, nil
	case "revoke":
		if len(args) != 2 {
			return 1, errorsForUsage("key revoke needs a key id")
		}
		keys, err := account.ListKeys()
		if err != nil {
			return 1, err
		}
		var revoked APIKeyInfo
		for _, key := range keys {
			if key.ID == args[1] {
				revoked = key
				break
			}
		}
		if revoked.ID == "" {
			return 1, fmt.Errorf("active API key %q not found", args[1])
		}
		if err := account.RevokeKey(revoked.ID); err != nil {
			return 1, err
		}
		if keyMatchesPrefix(cfg.APIKey, revoked.Prefix) {
			if err := saveConfig(func(saved *Config) { saved.APIKey = "" }); err != nil {
				return 1, err
			}
		}
		fmt.Println("revoked API key")
		return 0, nil
	default:
		return 1, fmt.Errorf("unknown key action %q", args[0])
	}
}

func keyCreateLabel(args []string) (string, error) {
	if len(args) == 0 {
		return "CLI: " + localDeviceLabel(), nil
	}
	if len(args) == 2 && args[0] == "--label" {
		return args[1], nil
	}
	return "", errorsForUsage("usage: inferspool key create [--label <name>]")
}

func configuredKeyBelongsTo(apiKey string, keys []APIKeyInfo) bool {
	for _, key := range keys {
		if keyMatchesPrefix(apiKey, key.Prefix) {
			return true
		}
	}
	return false
}

func keyMatchesPrefix(apiKey, prefix string) bool {
	return apiKey != "" && strings.HasPrefix(apiKey, "inferspool_"+prefix+"_")
}

func localDeviceLabel() string {
	host, err := osHostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "device"
	}
	return host
}

var osHostname = func() (string, error) { return os.Hostname() }

type usageError string

func (e usageError) Error() string        { return string(e) }
func errorsForUsage(message string) error { return usageError(message) }
