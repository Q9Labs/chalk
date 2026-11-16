//go:build !windows

package media

import "syscall"

// getSocketOptionInt reads an integer socket option from a socket's file descriptor.
func getSocketOptionInt(fd uintptr, level, option int) (int, error) {
	return syscall.GetsockoptInt(int(fd), level, option)
}
