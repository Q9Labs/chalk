package media

import (
	"fmt"
	"log/slog"
	"net"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// iceTCPReadBuffer is the datagram queue each ICE-TCP connection may hold unread.
const iceTCPReadBuffer = 32

// mediaSockets are the node's shared UDP socket, the ICE muxes on it and the buffers the kernel granted.
type mediaSockets struct {
	conn                      *net.UDPConn
	media                     net.PacketConn // conn, or the batching wrapper around it
	mux                       ice.UDPMux
	tcpMux                    ice.TCPMux // nil when the node has no TCP listener
	receiveBuffer, sendBuffer int
}

func openSockets(cfg config.Config, log *slog.Logger) (*mediaSockets, error) {
	address, err := net.ResolveUDPAddr("udp4", cfg.UDPAddr)
	if err != nil {
		return nil, fmt.Errorf("resolve UDP address %q: %w", cfg.UDPAddr, err)
	}
	conn, err := net.ListenUDP("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("listen on UDP %q: %w", cfg.UDPAddr, err)
	}
	media := newMediaConn(conn)
	sockets := &mediaSockets{
		conn: conn, media: media, mux: webrtc.NewICEUDPMux(nil, media),
		receiveBuffer: receiveSocketBuffer.size(conn, cfg.UDPReceiveBuffer, log),
		sendBuffer:    sendSocketBuffer.size(conn, cfg.UDPSendBuffer, log),
	}
	if cfg.TCPAddr == "" {
		return sockets, nil
	}
	listener, err := net.Listen("tcp4", cfg.TCPAddr)
	if err != nil {
		sockets.close()
		return nil, fmt.Errorf("listen on TCP %q: %w", cfg.TCPAddr, err)
	}
	sockets.tcpMux = webrtc.NewICETCPMux(nil, listener, iceTCPReadBuffer)
	return sockets, nil
}

func (s *mediaSockets) close() {
	if s.tcpMux != nil {
		_ = s.tcpMux.Close()
	}
	_ = s.mux.Close()
	_ = s.conn.Close()
}
