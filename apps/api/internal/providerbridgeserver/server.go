package providerbridgeserver

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mtls"
)

var (
	ErrInvalidConfig  = errors.New("invalid provider bridge server config")
	ErrAlreadyStarted = errors.New("provider bridge server already started")
)

type Server struct {
	address    string
	httpServer *http.Server
	tlsConfig  *tls.Config

	mu       sync.Mutex
	listener net.Listener
}

func New(cfg config.ProviderBridgeConfig, handler http.Handler) (*Server, error) {
	if !cfg.Enabled || cfg.Address == "" || handler == nil {
		return nil, ErrInvalidConfig
	}
	tlsConfig, err := mtls.LoadServerConfig(cfg.ServerCertFile, cfg.ServerKeyFile, cfg.ClientCAFile)
	if err != nil {
		return nil, errors.Join(ErrInvalidConfig, err)
	}
	return &Server{
		address:   cfg.Address,
		tlsConfig: tlsConfig,
		httpServer: &http.Server{
			Addr:              cfg.Address,
			Handler:           handler,
			ReadTimeout:       10 * time.Second,
			ReadHeaderTimeout: 5 * time.Second,
			WriteTimeout:      10 * time.Second,
			IdleTimeout:       30 * time.Second,
			MaxHeaderBytes:    64 * 1024,
		},
	}, nil
}

func (s *Server) Start() (<-chan error, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		return nil, ErrAlreadyStarted
	}
	listener, err := net.Listen("tcp", s.address)
	if err != nil {
		return nil, err
	}
	s.listener = tls.NewListener(listener, s.tlsConfig)
	result := make(chan error, 1)
	go func() {
		err := s.httpServer.Serve(s.listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		result <- err
	}()
	return result, nil
}

func (s *Server) Address() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return s.address
	}
	return s.listener.Addr().String()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}
