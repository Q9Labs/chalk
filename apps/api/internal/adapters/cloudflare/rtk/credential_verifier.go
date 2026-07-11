package rtk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const defaultParticipantAPIEndpoint = "https://api.dyte.io"

type CredentialVerifier struct {
	tokenOrgID string
	endpoint   string
	client     httpClient
}

type participantTokenClaims struct {
	OrganizationID string `json:"orgId"`
}

type participantDetailsEnvelope struct {
	Data json.RawMessage `json:"data"`
}

func NewCredentialVerifier(cfg config.CloudflareRealtimeConfig) (CredentialVerifier, error) {
	tokenOrgID := strings.TrimSpace(cfg.RTKTokenOrgID)
	if tokenOrgID == "" || cfg.RequestTimeout <= 0 {
		return CredentialVerifier{}, ErrMissingConfig
	}

	return CredentialVerifier{
		tokenOrgID: tokenOrgID,
		endpoint:   defaultParticipantAPIEndpoint,
		client:     &http.Client{Timeout: cfg.RequestTimeout},
	}, nil
}

func NewCredentialVerifierWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (CredentialVerifier, error) {
	verifier, err := NewCredentialVerifier(cfg)
	if err != nil {
		return CredentialVerifier{}, err
	}
	if client != nil {
		verifier.client = client
	}
	if strings.TrimSpace(endpoint) != "" {
		verifier.endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}

	return verifier, nil
}

func (v CredentialVerifier) Verify(ctx context.Context, credential string) error {
	claims, err := participantClaims(credential)
	if err != nil || claims.OrganizationID != v.tokenOrgID {
		return mediaplane.ErrCredentialNotApplicable
	}
	if v.client == nil {
		return mediaplane.ErrPlaneUnavailable
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.endpoint+"/v2/internals/participant-details", nil)
	if err != nil {
		return fmt.Errorf("build participant credential request: %w", errors.Join(mediaplane.ErrPlaneUnavailable, err))
	}
	request.Header.Set("Authorization", "Bearer "+credential)
	request.Header.Set("Accept", "application/json")

	response, err := v.client.Do(request)
	if err != nil {
		return fmt.Errorf("verify participant credential: %w", errors.Join(mediaplane.ErrPlaneUnavailable, err))
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return mediaplane.ErrInvalidCredential
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("participant credential provider status %d: %w", response.StatusCode, mediaplane.ErrPlaneUnavailable)
	}

	var envelope participantDetailsEnvelope
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&envelope); err != nil || len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return fmt.Errorf("decode participant credential response: %w", mediaplane.ErrPlaneUnavailable)
	}
	return nil
}

func participantClaims(credential string) (participantTokenClaims, error) {
	parts := strings.Split(strings.TrimSpace(credential), ".")
	if len(parts) != 3 {
		return participantTokenClaims{}, mediaplane.ErrCredentialNotApplicable
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return participantTokenClaims{}, mediaplane.ErrCredentialNotApplicable
	}
	var claims participantTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil || strings.TrimSpace(claims.OrganizationID) == "" {
		return participantTokenClaims{}, mediaplane.ErrCredentialNotApplicable
	}
	claims.OrganizationID = strings.TrimSpace(claims.OrganizationID)
	return claims, nil
}
