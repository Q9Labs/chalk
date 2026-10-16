package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"

	"strings"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

const (
	diagnosticMaxRequestBodyBytes = 1 << 20
)

type EpisodeDiagnosticsService interface {
	Append(context.Context, episodediagnostics.ProducerPrincipal, episodediagnostics.AppendDiagnosticEventsRequest) (episodediagnostics.AppendDiagnosticEventsResult, error)
}

type EpisodeDiagnosticsParticipantVerifier interface {
	Verify(context.Context, string) (accessgrants.DiagnosticsSubject, error)
}

type EpisodeDiagnosticsServiceVerifier interface {
	Verify(context.Context, string) (accessgrants.DiagnosticsServiceSubject, error)
}

type EpisodeDiagnosticsHTTPOptions struct {
	Mode                string
	Environment         episodediagnostics.Environment
	Service             EpisodeDiagnosticsService
	ProducerToken       string
	ParticipantVerifier EpisodeDiagnosticsParticipantVerifier
	ServiceVerifier     EpisodeDiagnosticsServiceVerifier
}

func mountEpisodeDiagnosticsRoutes(r chi.Router, options Options) {
	cfg := options.EpisodeDiagnostics
	if !diagnosticsHTTPEnabled(cfg) {
		return
	}

	r.Post("/_internal/episode-diagnostic-events", episodeDiagnosticAppendHandler(cfg))
}

func diagnosticsHTTPEnabled(options EpisodeDiagnosticsHTTPOptions) bool {
	mode := strings.ToLower(strings.TrimSpace(options.Mode))
	return mode == "localhost" || mode == "hosted"
}

func diagnosticEnvironment(options EpisodeDiagnosticsHTTPOptions) episodediagnostics.Environment {
	if options.Environment != "" {
		return options.Environment
	}
	if strings.EqualFold(strings.TrimSpace(options.Mode), "localhost") {
		return episodediagnostics.EnvironmentLocalhost
	}
	return episodediagnostics.EnvironmentDevelopment
}

func episodeDiagnosticAppendHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateDiagnosticsRequestOrigin(options, r); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		var request episodediagnostics.AppendDiagnosticEventsRequest
		if err := decodeEpisodeDiagnosticsJSON(w, r, &request); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		token, tokenOK := bearerToken(r.Header.Get("Authorization"))
		if !tokenOK {
			writeEpisodeDiagnosticsError(w, errDiagnosticProducerAuth)
			return
		}
		principal, err := authenticateDiagnosticProducer(r.Context(), options, token, request)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		result, err := options.Service.Append(r.Context(), principal, request)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func decodeEpisodeDiagnosticsJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, diagnosticMaxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid diagnostic request body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("invalid diagnostic request body: must contain one JSON value")
		}
		return fmt.Errorf("invalid diagnostic request body: %w", err)
	}
	return nil
}

func validateDiagnosticsRequestOrigin(options EpisodeDiagnosticsHTTPOptions, r *http.Request) error {
	if !strings.EqualFold(strings.TrimSpace(options.Mode), "localhost") {
		return nil
	}
	if !diagnosticRemoteIsLoopback(r.RemoteAddr) {
		return errDiagnosticOriginForbidden
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		// Browser fetches carry Fetch Metadata. The resolver CLI is a local
		// server-to-server client and intentionally has no Origin header, so
		// require an Origin whenever the request identifies itself as a browser.
		if r.Header.Get("Sec-Fetch-Site") != "" || r.Header.Get("Sec-Fetch-Mode") != "" {
			return errDiagnosticOriginForbidden
		}
		return nil
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || !diagnosticHostIsLoopback(parsed.Hostname()) {
		return errDiagnosticOriginForbidden
	}
	return nil
}

func diagnosticRemoteIsLoopback(remote string) bool {
	if remote == "" {
		return false
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = strings.Trim(remote, "[]")
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

func diagnosticHostIsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && address.IsLoopback()
}

var (
	errDiagnosticOriginForbidden = errors.New("diagnostic origin is forbidden")
	errDiagnosticProducerAuth    = errors.New("diagnostic producer authorization was denied")
)

func staticDiagnosticTokenMatches(candidate, expected string) bool {
	if candidate == "" || expected == "" {
		return false
	}
	expectedDigest := sha256.Sum256([]byte(expected))
	candidateDigest := sha256.Sum256([]byte(candidate))
	return hmac.Equal(expectedDigest[:], candidateDigest[:])
}

func authenticateDiagnosticProducer(ctx context.Context, options EpisodeDiagnosticsHTTPOptions, token string, request episodediagnostics.AppendDiagnosticEventsRequest) (episodediagnostics.ProducerPrincipal, error) {
	environment := diagnosticEnvironment(options)
	if options.Mode == "localhost" && staticDiagnosticTokenMatches(token, options.ProducerToken) {
		if request.Producer.ID != string(episodediagnostics.SourceSync) || !diagnosticEventsUseSource(request, episodediagnostics.SourceSync) {
			return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
		}
		return episodediagnostics.ProducerPrincipal{
			Kind:           episodediagnostics.ProducerService,
			ID:             string(episodediagnostics.SourceSync),
			InstanceID:     request.Producer.InstanceID,
			Generation:     request.Producer.Generation,
			Environment:    environment,
			AllowedSources: diagnosticServiceSources(),
		}, nil
	}
	if options.ServiceVerifier != nil {
		subject, verifyErr := options.ServiceVerifier.Verify(ctx, token)
		if verifyErr == nil {
			source, sourceOK := diagnosticServiceSource(string(subject.Source))
			if !sourceOK || subject.Capability != accessgrants.DiagnosticsServiceCapabilityAppend || subject.Environment != string(environment) || subject.Service == "" || subject.InstanceID == "" || subject.Generation <= 0 || source == episodediagnostics.SourceSync && subject.Service != string(episodediagnostics.SourceSync) || request.Producer.ID != string(source) || request.Producer.InstanceID != subject.InstanceID || request.Producer.Generation != subject.Generation || !diagnosticEventsUseSource(request, source) {
				return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
			}
			return episodediagnostics.ProducerPrincipal{Kind: episodediagnostics.ProducerService, ID: string(source), ServiceID: subject.Service, InstanceID: subject.InstanceID, Generation: subject.Generation, Environment: environment, AllowedSources: map[episodediagnostics.EventSource]struct{}{source: {}}}, nil
		}
	}
	if options.ParticipantVerifier == nil {
		return episodediagnostics.ProducerPrincipal{}, errDiagnosticProducerAuth
	}
	subject, err := options.ParticipantVerifier.Verify(ctx, token)
	if err != nil || subject.Capability != accessgrants.DiagnosticsCapability || episodicEnvironment(subject.Environment) != environment {
		return episodediagnostics.ProducerPrincipal{}, errDiagnosticProducerAuth
	}
	source, sourceOK := diagnosticParticipantSource(request.Producer.ID)
	if !sourceOK || request.Producer.Generation != subject.ParticipantGeneration || !diagnosticEventsUseSource(request, source) {
		return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
	}
	return episodediagnostics.ProducerPrincipal{
		Kind:                  episodediagnostics.ProducerParticipant,
		ID:                    request.Producer.ID,
		InstanceID:            request.Producer.InstanceID,
		Generation:            request.Producer.Generation,
		Environment:           environment,
		TenantID:              subject.TenantID,
		SpaceID:               subject.SpaceID,
		EpisodeID:             subject.EpisodeID,
		ParticipantID:         subject.ParticipantID,
		ParticipantGeneration: subject.ParticipantGeneration,
		AllowedSources:        map[episodediagnostics.EventSource]struct{}{source: {}},
	}, nil
}

func diagnosticServiceSource(source string) (episodediagnostics.EventSource, bool) {
	parsed := episodediagnostics.EventSource(source)
	switch parsed {
	case episodediagnostics.SourceAPI, episodediagnostics.SourceProvider, episodediagnostics.SourceWorker, episodediagnostics.SourceSync:
		return parsed, true
	default:
		return "", false
	}
}

func diagnosticEventsUseSource(request episodediagnostics.AppendDiagnosticEventsRequest, source episodediagnostics.EventSource) bool {
	for _, event := range request.Events {
		if event.Source != source {
			return false
		}
	}
	return len(request.Events) > 0
}

func diagnosticParticipantSource(id string) (episodediagnostics.EventSource, bool) {
	source := episodediagnostics.EventSource(id)
	switch source {
	case episodediagnostics.SourceUI, episodediagnostics.SourceSDK, episodediagnostics.SourceRTC:
		return source, true
	default:
		return "", false
	}
}

func episodicEnvironment(environment string) episodediagnostics.Environment {
	return episodediagnostics.Environment(environment)
}

func diagnosticServiceSources() map[episodediagnostics.EventSource]struct{} {
	return map[episodediagnostics.EventSource]struct{}{
		episodediagnostics.SourceSync: {},
	}
}

func writeEpisodeDiagnosticsError(w http.ResponseWriter, err error) {
	status, code, message := episodeDiagnosticsError(err)
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chalk-episode-diagnostics"`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code":    code,
		"message": message,
		"error":   map[string]string{"code": code, "message": message},
	})
}

func episodeDiagnosticsError(err error) (int, string, string) {
	var syntaxError *json.SyntaxError
	switch {
	case err == nil:
		return http.StatusInternalServerError, "diagnostic.internal", "Episode Diagnostics request failed"
	case errors.Is(err, errDiagnosticOriginForbidden):
		return http.StatusForbidden, "diagnostic.origin_forbidden", "Episode Diagnostics is restricted to the configured origin"
	case errors.Is(err, errDiagnosticProducerAuth), errors.Is(err, episodediagnostics.ErrUnauthenticated):
		return http.StatusUnauthorized, "diagnostic.unauthorized", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrForbidden):
		return http.StatusForbidden, "diagnostic.forbidden", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrDiagnosticEnvironmentMismatch):
		return http.StatusForbidden, "diagnostic.environment_forbidden", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrDiagnosticExpired):
		return http.StatusNotFound, "diagnostic.expired", "Episode Diagnostic was not found"
	case errors.Is(err, episodediagnostics.ErrDiagnosticIntakeClosed):
		return http.StatusGone, "diagnostic.intake_closed", "Episode Diagnostic intake is closed"
	case errors.Is(err, episodediagnostics.ErrNotFound):
		return http.StatusNotFound, "diagnostic.not_found", "Episode Diagnostic was not found"
	case errors.Is(err, episodediagnostics.ErrInvalidReference):
		return http.StatusBadRequest, "diagnostic.invalid_reference", "Diagnostic Reference is invalid"
	case errors.Is(err, episodediagnostics.ErrInvalidScope):
		return http.StatusBadRequest, "diagnostic.invalid_scope", "Diagnostic scope is invalid"
	case errors.Is(err, episodediagnostics.ErrConflict):
		return http.StatusConflict, "diagnostic.conflict", "Diagnostic Event conflicts with a retained Event"
	case errors.Is(err, episodediagnostics.ErrCapacity):
		return http.StatusTooManyRequests, "diagnostic.capacity", "Episode Diagnostics capacity is temporarily exhausted"
	case errors.Is(err, episodediagnostics.ErrDisabled):
		return http.StatusServiceUnavailable, "diagnostic.disabled", "Episode Diagnostics is unavailable"
	case errors.As(err, &syntaxError), errors.Is(err, io.ErrUnexpectedEOF):
		return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
	default:
		var validation *episodediagnostics.ValidationError
		if errors.As(err, &validation) {
			return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
		}
		if strings.Contains(strings.ToLower(err.Error()), "invalid") || strings.Contains(strings.ToLower(err.Error()), "required") || strings.Contains(strings.ToLower(err.Error()), "must be") {
			return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
		}
		if errors.Is(err, errDiagnosticOriginForbidden) {
			return http.StatusForbidden, "diagnostic.origin_forbidden", "Episode Diagnostics is restricted to the configured origin"
		}
		return http.StatusServiceUnavailable, "diagnostic.unavailable", "Episode Diagnostics is temporarily unavailable"
	}
}
