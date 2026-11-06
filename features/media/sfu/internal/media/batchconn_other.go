//go:build !linux

package media

import "net"

func newMuxConn(conn *net.UDPConn) net.PacketConn { return conn }
