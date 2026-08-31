//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

func platformShellCommand(command string) *exec.Cmd { return exec.Command("cmd.exe", "/C", command) }

func platformShellCommandContext(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "cmd.exe", "/C", command)
}

func prepareProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

func terminateProcessGroup(cmd *exec.Cmd, force bool) error {
	if force {
		return cmd.Process.Kill()
	}
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
