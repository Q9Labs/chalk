//go:build linux

package render

import "syscall"

func applyChildRlimits() {
	// The cgo runtime reserves about 1.6 GiB of address space before main on
	// x86 Linux, so a lower post-start cap leaves no room even for ordinary
	// pages. This ceiling still bounds hostile decompression expansion inside
	// the renderer Lambda memory envelope.
	_ = syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: 2048 << 20, Max: 2048 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: 20, Max: 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: 128 << 20, Max: 128 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 32, Max: 32})
}
