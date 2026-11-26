//go:build linux

package worker

import (
	"os"
	"strings"
	"syscall"
)

// MakeProcessNonDumpable removes the same-uid ptrace permission that would
// otherwise let an isolated child read this process's memory, file descriptors
// or environment through /proc. Lambda cannot reliably create user namespaces,
// so the fallback child shares the parent's uid even though its own environment
// is scrubbed.
func MakeProcessNonDumpable() error {
	_, _, errno := syscall.Syscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0)
	if errno == 0 {
		return nil
	}
	// Lambda's seccomp policy can deny prctl even though the execution image is
	// already launched non-dumpable. Accept that pre-protected state, but fail
	// closed when the kernel neither applies nor already has the protection.
	if errno == syscall.EPERM || errno == syscall.EINVAL {
		if dumpable, err := processDumpable(); err == nil && !dumpable {
			return nil
		}
	}
	return errno
}

func processDumpable() (bool, error) {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false, err
	}
	for line := range strings.Lines(string(status)) {
		if strings.HasPrefix(line, "Dumpable:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "Dumpable:")) != "0", nil
		}
	}
	return false, os.ErrNotExist
}
