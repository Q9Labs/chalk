// Command benchcerts writes a throwaway CA and the two leaf certificates a load test needs:
// the SFU's server certificate and the generator's client certificate. It follows the
// M1 test PKI (tests/pki_test.go): ECDSA P-256, one CA, the client certificate naming
// the service identity the SFU expects. The files go to a directory outside Git.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

func main() {
	dir := flag.String("out", "", "directory to write ca.pem, server.pem, server.key, client.pem, client.key")
	serverName := flag.String("server-name", "sfu.bench.test", "DNS name in the server certificate")
	identity := flag.String("identity", "chalk-api.test", "DNS name in the client certificate (SFU_CLIENT_IDENTITY)")
	lifetime := flag.Duration("lifetime", 12*time.Hour, "certificate lifetime")
	flag.Parse()
	if *dir == "" {
		log.Fatal("-out is required")
	}
	if err := generate(*dir, *serverName, *identity, *lifetime); err != nil {
		log.Fatal(err)
	}
}

func generate(dir, serverName, identity string, lifetime time.Duration) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	notBefore, notAfter := time.Now().Add(-time.Minute), time.Now().Add(lifetime)
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "chalk sfu bench CA"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		return err
	}
	if err := writePEM(filepath.Join(dir, "ca.pem"), "CERTIFICATE", caDER); err != nil {
		return err
	}
	leaf := func(name, file string, usage x509.ExtKeyUsage, serial int64) error {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return err
		}
		template := &x509.Certificate{
			SerialNumber: big.NewInt(serial),
			Subject:      pkix.Name{CommonName: name},
			DNSNames:     []string{name},
			IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
			NotBefore:    notBefore,
			NotAfter:     notAfter,
			KeyUsage:     x509.KeyUsageDigitalSignature,
			ExtKeyUsage:  []x509.ExtKeyUsage{usage},
		}
		der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
		if err != nil {
			return err
		}
		keyDER, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			return err
		}
		if err := writePEM(filepath.Join(dir, file+".pem"), "CERTIFICATE", der); err != nil {
			return err
		}
		return writePEM(filepath.Join(dir, file+".key"), "EC PRIVATE KEY", keyDER)
	}
	if err := leaf(serverName, "server", x509.ExtKeyUsageServerAuth, 2); err != nil {
		return err
	}
	if err := leaf(identity, "client", x509.ExtKeyUsageClientAuth, 3); err != nil {
		return err
	}
	fmt.Println("wrote certificates to", dir)
	return nil
}

func writePEM(path, blockType string, der []byte) error {
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600)
}
