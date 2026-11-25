//go:build linux

package worker

import (
	"errors"
	"os"
	"os/exec"
	"sync/atomic"
	"syscall"
)

func configureIsolatedChild(command *exec.Cmd) {
	uid, gid := os.Getuid(), os.Getgid()
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:                    true,
		Unshareflags:               syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET,
		UidMappings:                []syscall.SysProcIDMap{{ContainerID: uid, HostID: uid, Size: 1}},
		GidMappings:                []syscall.SysProcIDMap{{ContainerID: gid, HostID: gid, Size: 1}},
		GidMappingsEnableSetgroups: false,
	}
}

func configureIsolatedChildWithoutNamespaces(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func isolatedNamespaceError(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EINVAL)
}

var namespaceIsolationDisabled atomic.Bool

func isolatedNamespacesEnabled() bool {
	return !namespaceIsolationDisabled.Load()
}

func disableIsolatedNamespaces() {
	namespaceIsolationDisabled.Store(true)
}
