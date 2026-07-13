package workeridentity

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
)

var ErrInvalidTLSConfig = errors.New("invalid recorder mutual tls config")

func LoadTLSConfig(certificateFile string, privateKeyFile string, clientCAFile string) (*tls.Config, error) {
	certificateFile = strings.TrimSpace(certificateFile)
	privateKeyFile = strings.TrimSpace(privateKeyFile)
	clientCAFile = strings.TrimSpace(clientCAFile)
	if certificateFile == "" || privateKeyFile == "" || clientCAFile == "" {
		return nil, ErrInvalidTLSConfig
	}

	certificate, err := tls.LoadX509KeyPair(certificateFile, privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: load server certificate: %v", ErrInvalidTLSConfig, err)
	}
	clientCAPEM, err := os.ReadFile(clientCAFile)
	if err != nil {
		return nil, fmt.Errorf("%w: read client ca: %v", ErrInvalidTLSConfig, err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(clientCAPEM) {
		return nil, fmt.Errorf("%w: client ca contains no certificates", ErrInvalidTLSConfig)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
	}, nil
}
