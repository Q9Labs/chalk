//go:build !linux

package worker

import (
	"os"
	"os/exec"
)

func configureIsolatedChild(command *exec.Cmd, namespaces bool) {}

func isolatedNamespacesAvailable() bool { return true }

func isolatedChildProcessGroupID(pid int) int { return pid }

func killIsolatedChildProcessGroup(pgid int, process *os.Process) {
	if process != nil {
		_ = process.Kill()
	}
}
