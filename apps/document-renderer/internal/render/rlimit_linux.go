//go:build linux

package render

import "syscall"

func applyChildRlimits() {
	// PDFium and the cgo runtime need most of this address-space budget before
	// document allocation starts on x86 Linux; the cap still stops hostile
	// decompression expansion before it can evict sibling renders or the runtime.
	_ = syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: 1024 << 20, Max: 1024 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: 20, Max: 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: 128 << 20, Max: 128 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 32, Max: 32})
}
