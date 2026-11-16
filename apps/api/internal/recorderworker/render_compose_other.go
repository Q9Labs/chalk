//go:build !unix

package recorderworker

import (
	"errors"
	"os/exec"
)

var errLinuxOnly = errors.New("recorder worker runs only on Linux")

// isolateProcessGroup makes the command fail to start, because process groups need Unix.
func isolateProcessGroup(command *exec.Cmd) {
	command.Err = errLinuxOnly
}
