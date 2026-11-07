package media

import (
	"log/slog"
	"net"
	"syscall"
)

// socketBuffer is one of the UDP socket's two kernel buffers.
type socketBuffer struct {
	direction string // "receive" or "send", for logs
	option    int    // SO_RCVBUF or SO_SNDBUF
	set       func(*net.UDPConn, int) error
}

var (
	receiveSocketBuffer = socketBuffer{"receive", syscall.SO_RCVBUF, (*net.UDPConn).SetReadBuffer}
	sendSocketBuffer    = socketBuffer{"send", syscall.SO_SNDBUF, (*net.UDPConn).SetWriteBuffer}
)

// granted reads the buffer the kernel granted. Linux reports twice the usable size, because it
// counts its own bookkeeping, so the value is halved there.
func (b socketBuffer) granted(conn *net.UDPConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var size int
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		size, sockErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, b.option)
	}); err != nil {
		return 0, err
	}
	return size / socketBufferScale, sockErr
}

// size requests the buffer, logs what the kernel granted and returns it, zero when unknown. At
// the kernel's usual default of about 208 KiB a busy node drops packets, so the host must allow
// the request through net.core.rmem_max or net.core.wmem_max. A refused or reduced request still
// serves, with a warning. A request of zero keeps the kernel's default.
func (b socketBuffer) size(conn *net.UDPConn, requested int, log *slog.Logger) int {
	if requested > 0 {
		if err := b.set(conn, requested); err != nil {
			log.Warn("cannot set the UDP "+b.direction+" buffer", "requestedBytes", requested, "error", err)
		}
	}
	granted, err := b.granted(conn)
	switch {
	case err != nil:
		log.Warn("cannot read the UDP "+b.direction+" buffer size", "requestedBytes", requested, "error", err)
		return 0
	case granted < requested:
		log.Warn("UDP "+b.direction+" buffer is below the request; raise the host's net.core sysctl", "requestedBytes", requested, "grantedBytes", granted)
	default:
		log.Info("UDP "+b.direction+" buffer", "requestedBytes", requested, "grantedBytes", granted)
	}
	return granted
}
