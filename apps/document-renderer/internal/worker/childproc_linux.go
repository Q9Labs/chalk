//go:build linux

package worker

import (
	"os"
	"os/exec"
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
