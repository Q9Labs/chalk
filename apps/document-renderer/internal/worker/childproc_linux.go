//go:build linux

package worker

import (
	"os"
	"os/exec"
	"syscall"
)

func configureIsolatedChild(command *exec.Cmd, namespaces bool) {
	uid, gid := os.Getuid(), os.Getgid()
	attributes := &syscall.SysProcAttr{Setpgid: true}
	if namespaces {
		attributes.Unshareflags = syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET
		attributes.UidMappings = []syscall.SysProcIDMap{{ContainerID: uid, HostID: uid, Size: 1}}
		attributes.GidMappings = []syscall.SysProcIDMap{{ContainerID: gid, HostID: gid, Size: 1}}
		attributes.GidMappingsEnableSetgroups = false
	}
	command.SysProcAttr = attributes
}

func isolatedChildProcessGroupID(pid int) int {
	pgid, err := syscall.Getpgid(pid)
	if err == nil {
		return pgid
	}
	return pid
}

func killIsolatedChildProcessGroup(pgid int, process *os.Process) {
	if pgid > 0 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return
	}
	if process != nil {
		_ = process.Kill()
	}
}
