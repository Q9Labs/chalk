//go:build !linux

package media

import "net"

// newMediaConn has no batched path off Linux.
func newMediaConn(conn *net.UDPConn) net.PacketConn { return conn }
