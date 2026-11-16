//go:build unix

package recorderworker

import (
	"os/exec"
	"syscall"
	"time"
)

// isolateProcessGroup runs the command in its own process group and makes cancellation stop the
// whole group.
func isolateProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		pid := command.Process.Pid
		// Signal the whole group, including FFmpeg children. Escalate if any ignore SIGTERM.
		time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
		return syscall.Kill(-pid, syscall.SIGTERM)
	}
}
