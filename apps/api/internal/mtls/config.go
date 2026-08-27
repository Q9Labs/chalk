package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
)

var ErrInvalidConfig = errors.New("invalid mutual tls config")

func LoadServerConfig(certificateFile string, privateKeyFile string, clientCAFile string) (*tls.Config, error) {
	certificateFile = strings.TrimSpace(certificateFile)
	privateKeyFile = strings.TrimSpace(privateKeyFile)
	clientCAFile = strings.TrimSpace(clientCAFile)
	if certificateFile == "" || privateKeyFile == "" || clientCAFile == "" {
		return nil, ErrInvalidConfig
	}

	certificate, err := tls.LoadX509KeyPair(certificateFile, privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: load server certificate: %v", ErrInvalidConfig, err)
	}
	clientCAPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return nil, fmt.Errorf("%w: read client ca: %v", ErrInvalidConfig, err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(clientCAPEM) {
		return nil, fmt.Errorf("%w: client ca contains no certificates", ErrInvalidConfig)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// LoadClientConfig loads a mutually authenticated TLS 1.3 client with an
// explicit server trust root and name. It never falls back to ambient client
// certificates or the host's system roots.
func LoadClientConfig(certificateFile string, privateKeyFile string, serverCAFile string, serverName string) (*tls.Config, error) {
	certificateFile = strings.TrimSpace(certificateFile)
	privateKeyFile = strings.TrimSpace(privateKeyFile)
	serverCAFile = strings.TrimSpace(serverCAFile)
	serverName = strings.TrimSpace(serverName)
	if certificateFile == "" || privateKeyFile == "" || serverCAFile == "" || serverName == "" || strings.ContainsAny(serverName, "/\\:") {
		return nil, ErrInvalidConfig
	}

	certificate, err := tls.LoadX509KeyPair(certificateFile, privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: load client certificate: %v", ErrInvalidConfig, err)
	}
	serverCAPEM, err := os.ReadFile(serverCAFile)
	if err != nil {
		return nil, fmt.Errorf("%w: read server ca: %v", ErrInvalidConfig, err)
	}
	serverCAs := x509.NewCertPool()
	if !serverCAs.AppendCertsFromPEM(serverCAPEM) {
		return nil, fmt.Errorf("%w: server ca contains no certificates", ErrInvalidConfig)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		RootCAs:      serverCAs,
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS13,
	}, nil
}
