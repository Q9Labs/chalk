//go:build linux

package worker

import (
	"os"
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
	info, err := os.Lstat("/proc/self/environ")
	if err != nil {
		return false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false, os.ErrInvalid
	}
	// The kernel owns /proc/pid entries as root while dumpable is not 1.
	// Lambda blocks PR_GET_DUMPABLE, so ownership is the available evidence
	// that the runtime image was already started with equivalent protection.
	return stat.Uid == uint32(os.Geteuid()) && stat.Gid == uint32(os.Getegid()), nil
}
