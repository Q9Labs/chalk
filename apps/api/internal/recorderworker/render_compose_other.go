//go:build !unix

package recorderworker

import (
	"errors"
	"os/exec"
)

var errLinuxOnly = errors.New("recorder worker runs only on Linux")

func isolateProcessGroup(*exec.Cmd) error {
	return errLinuxOnly
}
