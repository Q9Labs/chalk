//go:build linux

package worker

import "syscall"

// MakeProcessNonDumpable removes the same-uid ptrace permission that would
// otherwise let an isolated child read this process's memory, file descriptors
// or environment through /proc. Lambda cannot reliably create user namespaces,
// so the fallback child shares the parent's uid even though its own environment
// is scrubbed.
func MakeProcessNonDumpable() error {
	_, _, errno := syscall.Syscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
