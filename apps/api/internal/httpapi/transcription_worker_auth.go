package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type HMACWorkloadAuthorizerConfig struct {
	Secret      []byte
	Environment string
	ReleaseID   string
	Audience    string
	Clock       func() time.Time
	Nonces      NonceStore
	Window      time.Duration
}
type HMACWorkloadAuthorizer struct{ config HMACWorkloadAuthorizerConfig }

const (
	workloadAuthorizationHeader = "Authorization"
	workloadTimestampHeader     = "X-Chalk-Workload-Timestamp"
	workloadNonceHeader         = "X-Chalk-Workload-Nonce"
	workloadBodySHAHeader       = "X-Chalk-Workload-Body-SHA256"
	workloadEnvironmentHeader   = "X-Chalk-Workload-Environment"
	workloadReleaseHeader       = "X-Chalk-Workload-Release"
	workloadRoleHeader          = "X-Chalk-Workload-Role"
	workloadAudienceHeader      = "X-Chalk-Workload-Audience"
	workloadJourneyHeader       = "X-Chalk-Journey-ID"
	workloadTraceparentHeader   = "traceparent"
	workloadTracestateHeader    = "tracestate"
)

func NewHMACWorkloadAuthorizer(config HMACWorkloadAuthorizerConfig) HMACWorkloadAuthorizer {
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.Window <= 0 {
		config.Window = 2 * time.Minute
	}
	return HMACWorkloadAuthorizer{config: config}
}

func (a HMACWorkloadAuthorizer) AuthorizeWorkload(ctx context.Context, request *http.Request, role string) error {
	if len(a.config.Secret) == 0 || a.config.Nonces == nil || request == nil || role == "" {
		return errors.New("workload authorization unavailable")
	}
	timestamp, err := strconv.ParseInt(request.Header.Get(workloadTimestampHeader), 10, 64)
	if err != nil {
		return errors.New("invalid workload timestamp")
	}
	now := a.config.Clock()
	observed := time.Unix(timestamp, 0)
	if observed.Before(now.Add(-a.config.Window)) || observed.After(now.Add(a.config.Window)) {
		return errors.New("expired workload signature")
	}
	nonce := request.Header.Get(workloadNonceHeader)
	if len(nonce) < 16 || len(nonce) > 128 {
		return errors.New("invalid workload nonce")
	}
	if request.Header.Get(workloadEnvironmentHeader) != a.config.Environment || request.Header.Get(workloadReleaseHeader) != a.config.ReleaseID || request.Header.Get(workloadRoleHeader) != role || request.Header.Get(workloadAudienceHeader) != a.config.Audience {
		return errors.New("workload audience mismatch")
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
	if err != nil {
		return errors.New("read workload body")
	}
	request.Body.Close()
	request.Body = io.NopCloser(bytes.NewReader(body))
	bodyDigest := sha256.Sum256(body)
	bodySHA := hex.EncodeToString(bodyDigest[:])
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get(workloadBodySHAHeader)), bodySHA) {
		return errors.New("workload body checksum mismatch")
	}
	canonical := strings.Join([]string{strings.ToUpper(request.Method), request.URL.EscapedPath(), bodySHA, strconv.FormatInt(timestamp, 10), nonce, a.config.Environment, a.config.ReleaseID, role, request.Header.Get(workloadJourneyHeader), request.Header.Get(workloadTraceparentHeader), request.Header.Get(workloadTracestateHeader), a.config.Audience}, "\n")
	mac := hmac.New(sha256.New, a.config.Secret)
	_, _ = mac.Write([]byte(canonical))
	expected := mac.Sum(nil)
	supplied, err := decodeAuthorization(request.Header.Get(workloadAuthorizationHeader))
	if err != nil || !hmac.Equal(expected, supplied) {
		return errors.New("invalid workload signature")
	}
	consumed, err := a.config.Nonces.Consume(ctx, nonce, a.config.Window)
	if err != nil {
		return errors.New("workload nonce store unavailable")
	}
	if !consumed {
		return errors.New("workload nonce replay")
	}
	return nil
}

func decodeSignature(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	return base64.RawURLEncoding.DecodeString(value)
}

func decodeAuthorization(value string) ([]byte, error) {
	const prefix = "Chalk-Workload-HMAC "
	if !strings.HasPrefix(value, prefix) {
		return nil, errors.New("invalid workload authorization")
	}
	return decodeSignature(strings.TrimSpace(strings.TrimPrefix(value, prefix)))
}
