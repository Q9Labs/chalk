//go:build !linux

package worker

import "os/exec"

func configureIsolatedChild(command *exec.Cmd) {}
