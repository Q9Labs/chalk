//go:build !linux

package worker

import "os/exec"

func configureIsolatedChild(command *exec.Cmd) {}

func configureIsolatedChildWithoutNamespaces(command *exec.Cmd) {}

func isolatedNamespaceError(err error) bool { return false }

func isolatedNamespacesEnabled() bool { return false }

func disableIsolatedNamespaces() {}
