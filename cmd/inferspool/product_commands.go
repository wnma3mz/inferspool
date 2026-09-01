package main

import (
	"fmt"
	"strings"
)

func accountClient() (*AccountClient, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	return NewAccountClient(cfg), nil
}

func cmdPassword(args []string) (int, error) {
	stdin := false
	for _, arg := range args {
		if arg == "--password-stdin" {
			stdin = true
		} else {
			return 1, errorsForUsage("password only accepts --password-stdin")
		}
	}
	password, err := readPassword(stdin)
	if err != nil {
		return 1, err
	}
	if len(password) < 8 {
		return 1, errorsForUsage("password must be at least 8 characters")
	}
	account, err := accountClient()
	if err != nil {
		return 1, err
	}
	if err := account.ChangePassword(password); err != nil {
		return 1, err
	}
	cfg, err := loadConfig()
	if err != nil {
		return 1, err
	}
	keys, err := account.ListKeys()
	if err != nil {
		return 1, fmt.Errorf("password changed, but preparing the CLI key failed: %w", err)
	}
	if !configuredKeyBelongsTo(cfg.APIKey, keys) {
		key, err := account.CreateKey("CLI: " + localDeviceLabel())
		if err != nil {
			return 1, fmt.Errorf("password changed, but creating the CLI key failed: %w", err)
		}
		if err := saveConfig(func(saved *Config) { saved.APIKey = key }); err != nil {
			return 1, err
		}
	}
	fmt.Println("password changed; CLI is ready")
	return 0, nil
}

func cmdWebhook(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errorsForUsage("webhook needs create, list, or delete")
	}
	account, err := accountClient()
	if err != nil {
		return 1, err
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return 1, errorsForUsage("webhook list takes no arguments")
		}
		hooks, err := account.ListWebhooks()
		if err != nil {
			return 1, err
		}
		if len(hooks) == 0 {
			fmt.Println("no webhooks")
			return 0, nil
		}
		for _, hook := range hooks {
			state := "active"
			if hook.DisabledAt != nil {
				state = "disabled"
			}
			fmt.Printf("%s  %-8s  %s  %s\n", hook.ID, state, strings.Join(hook.Events, ","), hook.URL)
		}
		return 0, nil
	case "create":
		if len(args) < 2 {
			return 1, errorsForUsage("webhook create needs an HTTPS URL")
		}
		events := []string{"job.succeeded", "job.failed", "job.canceled"}
		description := ""
		for i := 2; i < len(args); i++ {
			switch args[i] {
			case "--events":
				if i+1 >= len(args) {
					return 1, errorsForUsage("--events needs a value")
				}
				i++
				events = strings.Split(args[i], ",")
			case "--description":
				if i+1 >= len(args) {
					return 1, errorsForUsage("--description needs a value")
				}
				i++
				description = args[i]
			default:
				return 1, fmt.Errorf("unknown webhook flag %q", args[i])
			}
		}
		created, err := account.CreateWebhook(args[1], events, description)
		if err != nil {
			return 1, err
		}
		fmt.Printf("created %v\nsecret %v\nSave the secret now; it will not be shown again.\n", created["id"], created["secret"])
		return 0, nil
	case "delete":
		if len(args) != 2 {
			return 1, errorsForUsage("webhook delete needs an id")
		}
		if err := account.DeleteWebhook(args[1]); err != nil {
			return 1, err
		}
		fmt.Println("webhook deleted")
		return 0, nil
	default:
		return 1, fmt.Errorf("unknown webhook action %q", args[0])
	}
}

func cmdAdmin(args []string) (int, error) {
	if len(args) < 2 {
		return 1, errorsForUsage("admin needs user or worker, then an action")
	}
	account, err := accountClient()
	if err != nil {
		return 1, err
	}
	switch args[0] {
	case "worker":
		return cmdAdminWorker(account, args[1:])
	case "user":
		return cmdAdminUser(account, args[1:])
	default:
		return 1, fmt.Errorf("unknown admin resource %q", args[0])
	}
}

func cmdAdminWorker(account *AccountClient, args []string) (int, error) {
	switch args[0] {
	case "list":
		workers, err := account.AdminListWorkers()
		if err != nil {
			return 1, err
		}
		for _, worker := range workers {
			state := "enabled"
			if worker.DisabledAt != nil {
				state = "disabled"
			}
			heartbeat := "never"
			if worker.LastHeartbeat != nil {
				heartbeat = worker.LastHeartbeat.Format("2006-01-02 15:04:05")
			}
			var services []string
			for _, service := range worker.Services {
				status := "down"
				if service.Healthy {
					status = "up"
				}
				services = append(services, service.Type+":"+status)
			}
			fmt.Printf("%-24s %-9s %-24s %s\n", worker.ID, state, strings.Join(services, ","), heartbeat)
		}
		return 0, nil
	case "create":
		if len(args) < 2 {
			return 1, errorsForUsage("admin worker create needs an id")
		}
		name := args[1]
		for i := 2; i < len(args); i++ {
			switch args[i] {
			case "--name":
				if i+1 >= len(args) {
					return 1, errorsForUsage("--name needs a value")
				}
				i++
				name = args[i]
			default:
				return 1, fmt.Errorf("unknown worker flag %q", args[i])
			}
		}
		created, err := account.AdminCreateWorker(args[1], name)
		if err != nil {
			return 1, err
		}
		fmt.Print(created["env"])
		return 0, nil
	case "rotate-token", "disable", "enable", "revoke":
		if len(args) != 2 {
			return 1, errorsForUsage("worker action needs an id")
		}
		action := args[0]
		result, err := account.AdminWorkerAction(args[1], action)
		if err != nil {
			return 1, err
		}
		if token, ok := result["token"].(string); ok {
			fmt.Printf("INFERSPOOL_WORKER_ID=%s\nINFERSPOOL_WORKER_TOKEN=%s\n", args[1], token)
		} else {
			fmt.Println(action + "d")
		}
		return 0, nil
	default:
		return 1, fmt.Errorf("unknown worker action %q", args[0])
	}
}

func cmdAdminUser(account *AccountClient, args []string) (int, error) {
	switch args[0] {
	case "list":
		users, err := account.AdminListUsers()
		if err != nil {
			return 1, err
		}
		for _, user := range users {
			fmt.Printf("%s  %-10s  %s\n", user.ID, user.Profile.Status, user.Email)
		}
		return 0, nil
	case "create", "invite":
		if len(args) != 2 {
			return 1, errorsForUsage("admin user create needs an email")
		}
		created, err := account.AdminCreateUser(args[1])
		if err != nil {
			return 1, err
		}
		fmt.Printf("email %v\ntemporary password %v\n", created["email"], created["temporary_password"])
		return 0, nil
	case "reset-password", "disable", "enable", "delete":
		if len(args) != 2 {
			return 1, errorsForUsage("user action needs a user id")
		}
		result, err := account.AdminUserAction(args[1], args[0])
		if err != nil {
			return 1, err
		}
		if password, ok := result["temporary_password"].(string); ok {
			fmt.Println(password)
		} else {
			fmt.Println(args[0] + "d")
		}
		return 0, nil
	default:
		return 1, fmt.Errorf("unknown user action %q", args[0])
	}
}
