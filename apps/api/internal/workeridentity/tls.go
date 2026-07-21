package workeridentity

import (
	"crypto/tls"

	"github.com/q9labs/chalk/apps/api/internal/mtls"
)

var ErrInvalidTLSConfig = mtls.ErrInvalidConfig

func LoadTLSConfig(certificateFile string, privateKeyFile string, clientCAFile string) (*tls.Config, error) {
	return mtls.LoadServerConfig(certificateFile, privateKeyFile, clientCAFile)
}
