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
