// Package control serves the SFU's internal /v1 API over mutual TLS.
package control

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// Server is the running service: the control listener and the media node.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	node     *media.Node
	http     *http.Server
	listener net.Listener
	served   chan error
}

// Start binds the media and control sockets and begins serving.
func Start(cfg config.Config, log *slog.Logger) (*Server, error) {
	tlsConfig, err := serverTLS(cfg)
	if err != nil {
		return nil, err
	}
	node, err := media.NewNode(cfg, log)
	if err != nil {
		return nil, err
	}
	listener, err := tls.Listen("tcp", cfg.ControlAddr, tlsConfig)
	if err != nil {
		node.Close()
		return nil, fmt.Errorf("listen on control address %q: %w", cfg.ControlAddr, err)
	}
	s := &Server{cfg: cfg, log: log, node: node, listener: listener, served: make(chan error, 1)}
	s.http = &http.Server{
		Handler:           s.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	go func() { s.served <- s.http.Serve(listener) }()
	return s, nil
}

// serverTLS requires a client certificate signed by the configured CA. The
// handler additionally checks the certificate's identity.
func serverTLS(cfg config.Config) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load server certificate: %w", err)
	}
	authority, err := os.ReadFile(cfg.ClientCAFile)
	if err != nil {
		return nil, fmt.Errorf("read client CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(authority) {
		return nil, errors.New("client CA file holds no certificate")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
	}, nil
}

// Addr is the control listener's address.
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

// UDPPort is the shared media port.
func (s *Server) UDPPort() int { return s.node.UDPPort() }

// Stop drains the service: readiness fails, in-flight requests finish, then
// every session closes and the sockets are released.
func (s *Server) Stop(ctx context.Context) error {
	s.node.Drain()
	shutdownCtx, cancel := context.WithTimeout(ctx, s.cfg.ShutdownTimeout)
	defer cancel()
	err := s.http.Shutdown(shutdownCtx)
	if err != nil {
		_ = s.http.Close()
	}
	if serveErr := <-s.served; serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		err = errors.Join(err, serveErr)
	}
	s.node.Close()
	return err
}
