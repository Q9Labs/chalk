package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Certificate expiry warns twice. The 21-day and the 7-day text differ, so Axiom
// groups them apart and notifies again at 7 days.
const (
	certWarnWindow   = 21 * 24 * time.Hour
	certUrgentWindow = 7 * 24 * time.Hour
	// Every certificate is read at once, so one slow node costs certNodeTimeout, not
	// a multiple of it. certOverallCap bounds the whole check well inside run's 30 s.
	certNodeTimeout = 3 * time.Second
	certOverallCap  = 8 * time.Second
)

// certReading is one certificate the collector can see. A failed reading carries
// the allowlisted text that needs an engineer; it never holds TLS error text.
type certReading struct {
	label    string
	notAfter time.Time
	failure  string
}

// collectCertificateExpiry gives one global row when a certificate source is
// configured and none otherwise. Value 1 means a certificate expires within 21
// days, has expired, or the direct door cannot be verified; the reason lists every
// finding. Expiry is read without chain verification, because an expired
// certificate fails verification and must still read as expired. An SFU node that
// cannot be reached is the readiness row's concern, so it adds nothing here.
func collectCertificateExpiry(ctx context.Context, probes []sfuProbe, doorURL string, now time.Time) []snapshot {
	ctx, cancel := context.WithTimeout(ctx, certOverallCap)
	defer cancel()
	var readings []certReading
	if len(probes) > 0 {
		if notAfter, ok := fileCertificateNotAfter(probes[0].ClientCertFile); ok {
			readings = append(readings, certReading{label: "the API client certificate for the Chalk SFU", notAfter: notAfter})
		}
	}
	nodes := make([]certReading, len(probes))
	var door certReading
	var wg sync.WaitGroup
	for i, probe := range probes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			nodes[i] = sfuServerCertificate(ctx, probe)
		}()
	}
	if doorURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			door = doorCertificate(ctx, doorURL)
		}()
	}
	wg.Wait()
	for _, node := range nodes {
		if node.label != "" {
			readings = append(readings, node)
		}
	}
	if door.label != "" {
		readings = append(readings, door)
	}
	if len(readings) == 0 {
		return nil
	}
	item := snapshot{Rule: ruleCertificateExpiry, Reason: "all_valid", Time: now.UTC().Format(time.RFC3339Nano)}
	var findings []string
	seen := make(map[string]bool)
	for _, reading := range readings {
		finding := ""
		left := reading.notAfter.Sub(now)
		switch {
		case reading.failure != "":
			finding = reading.failure
		case left <= 0:
			finding = reading.label + " has expired"
		case left <= certUrgentWindow:
			finding = reading.label + " expires within 7 days"
		case left <= certWarnWindow:
			finding = reading.label + " expires within 21 days"
		}
		if finding != "" && !seen[finding] {
			seen[finding] = true
			findings = append(findings, finding)
		}
	}
	if len(findings) > 0 {
		item.Value, item.Reason = 1, strings.Join(findings, "; ")
	}
	return []snapshot{item}
}

func fileCertificateNotAfter(path string) (time.Time, bool) {
	pemBytes, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, false
	}
	for {
		var block *pem.Block
		block, pemBytes = pem.Decode(pemBytes)
		if block == nil {
			return time.Time{}, false
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		leaf, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return time.Time{}, false
		}
		return leaf.NotAfter, true
	}
}

// serverCertificate says what one verified TLS handshake showed about a server.
type serverCertificate struct {
	// reached is false when no handshake completed and verification never failed
	// (refused, timed out, reset): the caller decides what that means.
	reached   bool
	untrusted bool
	// notAfter is the effective expiry: the earliest NotAfter along the verified
	// chain, or the NotAfter of the certificate verification found expired.
	notAfter time.Time
	// byCA is true when a certificate above the server's own ends first, so renewing
	// the server certificate would not help.
	byCA bool
}

// sfuServerCertificate reads one node's server certificate. A node that cannot be
// reached gives no reading: the readiness row owns that. A certificate that does not
// chain to the configured CA for the configured name is a finding of its own,
// because an impostor must not be able to hide an expiring or expired certificate.
func sfuServerCertificate(ctx context.Context, probe sfuProbe) certReading {
	client, err := sfuClient(probe)
	if err != nil {
		return certReading{}
	}
	// The configured CA is the pinned root, so its own expiry counts too.
	seen := verifiedServerCertificate(ctx, probe.URL, client.Transport.(*http.Transport).TLSClientConfig, true)
	if !seen.reached {
		return certReading{}
	}
	reading := certReading{label: "a Chalk SFU server certificate", notAfter: seen.notAfter}
	if seen.byCA {
		reading.label = "the CA of the Chalk SFU server certificates"
	}
	if seen.untrusted {
		reading.failure = "a Chalk SFU server certificate is untrusted"
	}
	return reading
}

// doorRoots is the door's trust store; nil means the system roots. Tests set it.
var doorRoots *x509.CertPool

// doorCertificate reads the door's expiry over a verified handshake, so an expired
// certificate reads as expired and an untrusted or unreachable door as a failure. A
// system root's own expiry is not the door's to renew, so it does not count.
func doorCertificate(ctx context.Context, doorURL string) certReading {
	reading := certReading{label: "the direct door certificate", failure: "the direct door could not be verified over TLS"}
	seen := verifiedServerCertificate(ctx, doorURL, &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: doorRoots}, false)
	if seen.reached && !seen.untrusted {
		reading.notAfter, reading.failure = seen.notAfter, ""
		if seen.byCA {
			reading.label = "an intermediate certificate of the direct door"
		}
	}
	return reading
}

// verifiedServerCertificate completes a TLS handshake with the URL's host using
// normal verification. A chain that verifies gives its effective expiry. A chain
// that fails only because a certificate has expired gives that certificate's
// NotAfter, because an expired certificate is the very thing this check reports.
// Any other verification failure (unknown authority, wrong name) is untrusted.
// An untrusted failure may carry no certificates to read, and then nothing is
// known about its expiry.
func verifiedServerCertificate(ctx context.Context, rawURL string, config *tls.Config, includeRoot bool) serverCertificate {
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "https" || target.Hostname() == "" {
		return serverCertificate{}
	}
	port := target.Port()
	if port == "" {
		port = "443"
	}
	ctx, cancel := context.WithTimeout(ctx, certNodeTimeout)
	defer cancel()
	dialer := tls.Dialer{Config: config}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Hostname(), port))
	if err != nil {
		var verification *tls.CertificateVerificationError
		if !errors.As(err, &verification) {
			return serverCertificate{}
		}
		var invalid x509.CertificateInvalidError
		if errors.As(verification.Err, &invalid) && invalid.Reason == x509.Expired && invalid.Cert != nil {
			presented := verification.UnverifiedCertificates
			return serverCertificate{reached: true, notAfter: invalid.Cert.NotAfter, byCA: len(presented) > 0 && !invalid.Cert.Equal(presented[0])}
		}
		return serverCertificate{reached: true, untrusted: true}
	}
	defer conn.Close()
	notAfter, byCA := effectiveExpiry(conn.(*tls.Conn).ConnectionState().VerifiedChains, includeRoot)
	return serverCertificate{reached: true, notAfter: notAfter, byCA: byCA}
}

// effectiveExpiry is the earliest NotAfter along the best verified path, because a
// handshake fails once any certificate on it has expired. byCA says the earliest
// is a certificate above the leaf. The root counts only when it is the configured
// CA (includeRoot); a system root's own expiry is not this certificate's to renew.
func effectiveExpiry(chains [][]*x509.Certificate, includeRoot bool) (best time.Time, byCA bool) {
	for _, path := range chains {
		if !includeRoot && len(path) > 1 {
			path = path[:len(path)-1]
		}
		earliest, above := path[0].NotAfter, false
		for _, certificate := range path[1:] {
			if certificate.NotAfter.Before(earliest) {
				earliest, above = certificate.NotAfter, true
			}
		}
		if earliest.After(best) {
			best, byCA = earliest, above
		}
	}
	return best, byCA
}
