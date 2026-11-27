//go:build !linux

package worker

func MakeProcessNonDumpable() error { return nil }
