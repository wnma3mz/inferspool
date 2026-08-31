//go:build !windows

package main

import (
	"context"
	"os/exec"
	"syscall"
)

func platformShellCommand(command string) *exec.Cmd { return exec.Command("/bin/sh", "-c", command) }

func platformShellCommandContext(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "/bin/sh", "-c", command)
}

func prepareProcessGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func terminateProcessGroup(cmd *exec.Cmd, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	group, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		return cmd.Process.Signal(signal)
	}
	return syscall.Kill(-group, signal)
}
