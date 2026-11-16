package media

import "syscall"

// getSocketOptionInt reads an integer socket option from a socket's handle, which Windows
// types as syscall.Handle rather than a file descriptor int.
func getSocketOptionInt(fd uintptr, level, option int) (int, error) {
	return syscall.GetsockoptInt(syscall.Handle(fd), level, option)
}
