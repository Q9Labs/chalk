package recorderarchive

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

const testSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testKey(t *testing.T, pkcs8 bool) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	block := &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}
	if pkcs8 {
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		block = &pem.Block{Type: "PRIVATE KEY", Bytes: der}
	}
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(block))
}

func testArchive() recorderfleet.ArchiveSpec {
	return recorderfleet.ArchiveSpec{Bucket: "chalk-nightly-artifacts-123456789012", Key: "recorder/render/" + testSHA + ".tar.gz", SHA256: testSHA, Region: "ap-southeast-1"}
}

func TestPresignCDNSignsArchivePathUntilStartupDeadline(t *testing.T) {
	for _, pkcs8 := range []bool{false, true} {
		cdn, err := NewCDN("https://d111111abcdef8.cloudfront.net", "KTESTKEY", testKey(t, pkcs8))
		if err != nil {
			t.Fatalf("pkcs8=%v: %v", pkcs8, err)
		}
		now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
		signed, err := cdn.PresignCDN(testArchive(), 10*time.Minute, now)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := url.Parse(signed)
		if err != nil {
			t.Fatal(err)
		}
		if parsed.Scheme != "https" || parsed.Host != "d111111abcdef8.cloudfront.net" || parsed.Path != "/recorder/render/"+testSHA+".tar.gz" {
			t.Fatalf("unexpected link %s", signed)
		}
		query := parsed.Query()
		if query.Get("Key-Pair-Id") != "KTESTKEY" || query.Get("Signature") == "" {
			t.Fatalf("missing signature parameters in %s", signed)
		}
		expires, err := strconv.ParseInt(query.Get("Expires"), 10, 64)
		if err != nil || expires != now.Add(15*time.Minute).Unix() {
			t.Fatalf("expires %q, want %d", query.Get("Expires"), now.Add(15*time.Minute).Unix())
		}
		if strings.ContainsAny(query.Get("Signature"), "+=/") {
			t.Fatalf("signature must use the CloudFront URL-safe alphabet: %s", query.Get("Signature"))
		}
	}
}

func TestPresignCDNRejectsForeignKeysAndTimeouts(t *testing.T) {
	cdn, err := NewCDN("https://d111111abcdef8.cloudfront.net/", "KTESTKEY", testKey(t, false))
	if err != nil {
		t.Fatal(err)
	}
	foreign := testArchive()
	foreign.Key = "recorder/render/other.tar.gz"
	if _, err := cdn.PresignCDN(foreign, time.Minute, time.Now()); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("foreign key: %v", err)
	}
	if _, err := cdn.PresignCDN(testArchive(), 0, time.Now()); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
		t.Fatalf("zero timeout: %v", err)
	}
}

func TestNewCDNRejectsBadSettings(t *testing.T) {
	key := testKey(t, false)
	cases := map[string][3]string{
		"http origin": {"http://d111111abcdef8.cloudfront.net", "K", key},
		"with query":  {"https://d111111abcdef8.cloudfront.net/?x=1", "K", key},
		"no key id":   {"https://d111111abcdef8.cloudfront.net", "", key},
		"not base64":  {"https://d111111abcdef8.cloudfront.net", "K", "%%%"},
		"not pem":     {"https://d111111abcdef8.cloudfront.net", "K", base64.StdEncoding.EncodeToString([]byte("nope"))},
	}
	for name, c := range cases {
		if _, err := NewCDN(c[0], c[1], c[2]); !errors.Is(err, recorderfleet.ErrInvalidConfig) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
