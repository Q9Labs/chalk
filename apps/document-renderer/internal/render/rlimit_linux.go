//go:build linux

package render

import (
	"errors"
	"syscall"
)

func applyChildRlimits(mode string) error {
	if mode == "office" {
		return errors.Join(
			syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: 4096 << 20, Max: 4096 << 20}),
			syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: 60, Max: 60}),
			syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: 128 << 20, Max: 128 << 20}),
			syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 1024, Max: 1024}),
		)
	}
	// The cgo runtime reserves about 1.6 GiB of address space before main on
	// x86 Linux, so a lower post-start cap leaves no room even for ordinary
	// pages. This ceiling still bounds hostile decompression expansion inside
	// the renderer Lambda memory envelope.
	return errors.Join(
		syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: 2048 << 20, Max: 2048 << 20}),
		syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: 30, Max: 30}),
		syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: 128 << 20, Max: 128 << 20}),
		syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 32, Max: 32}),
	)
}
