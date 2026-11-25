//go:build linux

package render

import "syscall"

func applyChildRlimits() {
	// PDFium's measured peak is far below this on ordinary documents; the cap
	// exists to stop hostile decompression expansion before it can evict the
	// sibling render or the Lambda runtime.
	_ = syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{Cur: 768 << 20, Max: 768 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: 20, Max: 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: 128 << 20, Max: 128 << 20})
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 32, Max: 32})
}
