//go:build !linux

package worker

import "os/exec"

func configureIsolatedChild(command *exec.Cmd) {}

func killIsolatedChildProcessGroup(command *exec.Cmd) {
	if command.Process != nil {
		_ = command.Process.Kill()
	}
}
