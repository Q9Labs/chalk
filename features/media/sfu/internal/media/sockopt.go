package media

import (
	"net"
	"syscall"
)

// receiveBufferSize reads SO_RCVBUF. Linux reports twice the usable size,
// because it counts its own bookkeeping, so the granted value is halved there.
func receiveBufferSize(conn *net.UDPConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var size int
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		size, sockErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	}); err != nil {
		return 0, err
	}
	return size / receiveBufferScale, sockErr
}
