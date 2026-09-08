package recorderfleetissuer

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

type CertificateAuthority struct {
	certificate *x509.Certificate
	chainPEM    string
	signer      crypto.Signer
	trustDomain string
}

func NewCertificateAuthority(certificatePEM []byte, privateKeyPEM []byte, trustDomain string) (*CertificateAuthority, error) {
	certificateBlock, rest := pem.Decode(certificatePEM)
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, ErrInvalidConfig
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil || !certificate.IsCA {
		return nil, ErrInvalidConfig
	}
	keyBlock, keyRest := pem.Decode(privateKeyPEM)
	if keyBlock == nil || len(strings.TrimSpace(string(keyRest))) != 0 {
		return nil, ErrInvalidConfig
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, ErrInvalidConfig
	}
	signerPublic, signerErr := x509.MarshalPKIXPublicKey(signer.Public())
	certificatePublic, certificateErr := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	if signerErr != nil || certificateErr != nil || !bytes.Equal(signerPublic, certificatePublic) || strings.TrimSpace(trustDomain) == "" || strings.ContainsAny(trustDomain, "/\\:") {
		return nil, ErrInvalidConfig
	}
	return &CertificateAuthority{certificate: certificate, chainPEM: string(certificatePEM), signer: signer, trustDomain: trustDomain}, nil
}

func (authority *CertificateAuthority) issue(csr *x509.CertificateRequest, identity recorderfleet.NodeIdentity, environment string, now time.Time, lifetime time.Duration) (certificateRecord, error) {
	if now.Before(authority.certificate.NotBefore) || !now.Add(lifetime).Before(authority.certificate.NotAfter) {
		return certificateRecord{}, errors.New("worker certificate authority cannot cover requested lifetime")
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return certificateRecord{}, fmt.Errorf("generate worker certificate serial: %w", err)
	}
	identityURI, err := url.Parse(fmt.Sprintf("spiffe://%s/environment/%s/%s/%s", authority.trustDomain, url.PathEscape(environment), identity.Role, identity.WorkerID))
	if err != nil {
		return certificateRecord{}, fmt.Errorf("build worker identity URI: %w", err)
	}
	notBefore := now.Add(-time.Minute)
	notAfter := now.Add(lifetime)
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: identity.WorkerID},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		URIs:         []*url.URL{identityURI},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.certificate, csr.PublicKey, authority.signer)
	if err != nil {
		return certificateRecord{}, fmt.Errorf("sign worker certificate: %w", err)
	}
	return certificateRecord{
		SerialNumber: serial.Text(16), PEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		NotAfter: notAfter, IssuedAt: now,
	}, nil
}

func (authority *CertificateAuthority) revocationList(registrations map[string]*registration, now time.Time) ([]byte, error) {
	entries := make([]x509.RevocationListEntry, 0)
	for _, registration := range registrations {
		if registration.RevokedAt == nil {
			continue
		}
		for _, certificate := range registration.Certificates {
			serial, ok := new(big.Int).SetString(certificate.SerialNumber, 16)
			if !ok {
				return nil, fmt.Errorf("%w: invalid persisted certificate serial", ErrInvalidConfig)
			}
			entries = append(entries, x509.RevocationListEntry{SerialNumber: serial, RevocationTime: *registration.RevokedAt})
		}
	}
	numberBytes := make([]byte, 16)
	if _, err := rand.Read(numberBytes); err != nil {
		return nil, fmt.Errorf("generate revocation list number: %w", err)
	}
	template := &x509.RevocationList{
		Number: big.NewInt(0).SetBytes(numberBytes), ThisUpdate: now, NextUpdate: now.Add(5 * time.Minute),
		RevokedCertificateEntries: entries,
	}
	der, err := x509.CreateRevocationList(rand.Reader, template, authority.certificate, authority.signer)
	if err != nil {
		return nil, fmt.Errorf("sign worker revocation list: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "X509 CRL", Bytes: der}), nil
}

func certificateHash(csr *x509.CertificateRequest) string {
	digest := sha256.Sum256(csr.Raw)
	return hex.EncodeToString(digest[:])
}
