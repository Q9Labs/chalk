package sfu

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// providerDescription is kept separate from the media-plane envelope so
// the provider-specific shape cannot cross the captureplane port.
type providerDescription struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

type providerConnectionEnvelope struct {
	ConnectionReference string `json:"sessionId,omitempty"`
}

type providerDescriptionEnvelope struct {
	Description *providerDescription `json:"sessionDescription,omitempty"`
}

type captureCreateConnectionResponse struct {
	providerConnectionEnvelope
	providerDescriptionEnvelope
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

func (r *captureCreateConnectionResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, 0, 0)
}

type captureSimulcast struct {
	PreferredRID string `json:"preferredRid,omitempty"`
}

type captureTrackRequest struct {
	providerConnectionEnvelope
	Location  string            `json:"location"`
	Mid       string            `json:"mid,omitempty"`
	TrackName string            `json:"trackName"`
	Kind      string            `json:"kind,omitempty"`
	Simulcast *captureSimulcast `json:"simulcast,omitempty"`
}

type captureTracksRequest struct {
	providerDescriptionEnvelope
	Tracks       []captureTrackRequest `json:"tracks"`
	AutoDiscover bool                  `json:"autoDiscover"`
}

type captureTrackResult struct {
	providerConnectionEnvelope
	Location         string            `json:"location"`
	Mid              string            `json:"mid"`
	TrackName        string            `json:"trackName"`
	Kind             string            `json:"kind"`
	Simulcast        *captureSimulcast `json:"simulcast,omitempty"`
	ErrorCode        string            `json:"errorCode"`
	ErrorDescription string            `json:"errorDescription"`
}

type captureTracksResponse struct {
	providerDescriptionEnvelope
	ErrorCode                      string               `json:"errorCode"`
	ErrorDescription               string               `json:"errorDescription"`
	Tracks                         []captureTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool                 `json:"requiresImmediateRenegotiation"`
}

func (r *captureTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), captureTrackFailureCount(r.Tracks))
	}
	for _, track := range r.Tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(r.Tracks), captureTrackFailureCount(r.Tracks))
		}
	}
	return nil
}

type captureRenegotiateRequest struct {
	providerDescriptionEnvelope
}

type captureRenegotiateResponse struct {
	providerDescriptionEnvelope
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

func (r *captureRenegotiateResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, 0, 0)
}

type captureCloseTrack struct {
	Mid string `json:"mid"`
}

type captureCloseTrackResult struct {
	Mid              string `json:"mid"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type captureCloseTracksRequest struct {
	Tracks []captureCloseTrack `json:"tracks"`
	Force  bool                `json:"force"`
}

type captureCloseTracksResponse struct {
	providerDescriptionEnvelope
	ErrorCode                      string                    `json:"errorCode"`
	ErrorDescription               string                    `json:"errorDescription"`
	Tracks                         []captureCloseTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool                      `json:"requiresImmediateRenegotiation"`
}

func (r *captureCloseTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), captureCloseTrackFailureCount(r.Tracks))
	}
	return nil
}

type captureObservedTrack struct {
	providerConnectionEnvelope
	Location         string `json:"location"`
	Mid              string `json:"mid"`
	TrackName        string `json:"trackName"`
	Status           string `json:"status"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type captureInspectResponse struct {
	ErrorCode        string                 `json:"errorCode"`
	ErrorDescription string                 `json:"errorDescription"`
	Tracks           []captureObservedTrack `json:"tracks"`
}

func (r *captureInspectResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) == "" && strings.TrimSpace(r.ErrorDescription) == "" {
		return nil
	}
	return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), 0)
}

type captureTrackKey struct {
	owner string
	track string
}

type captureReplayEntry struct {
	payloadDigest [32]byte
	result        any
}

type captureReplayRegistry struct {
	mu       sync.Mutex
	entries  map[string]captureReplayEntry
	order    []string
	capacity int
}

const (
	captureReplayCapacity   = 1024
	providerConnectionsPath = "/sessions"
)

// The adapter replay cache only covers an in-process retry. The durable
// capturesignaling queue remains the source of truth across restarts and for
// exact production replay.
func newCaptureReplayRegistry() *captureReplayRegistry {
	return &captureReplayRegistry{entries: make(map[string]captureReplayEntry), capacity: captureReplayCapacity}
}

func captureReplayIdentity(a Adapter, metadata captureplane.OperationMetadata, operation captureplane.OperationKind, input any) (string, [32]byte, error) {
	scope, err := metadata.IdempotencyScope(operation)
	if err != nil {
		return "", [32]byte{}, err
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return "", [32]byte{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_request", Retryable: false}
	}
	return hex.EncodeToString(scope[:]), sha256.Sum256(payload), nil
}

func captureReplayLookup[T any](a Adapter, metadata captureplane.OperationMetadata, operation captureplane.OperationKind, input any) (T, bool, error) {
	var zero T
	key, digest, err := captureReplayIdentity(a, metadata, operation, input)
	if err != nil {
		return zero, false, err
	}
	if a.captureReplay == nil {
		return zero, false, nil
	}
	a.captureReplay.mu.Lock()
	entry, ok := a.captureReplay.entries[key]
	a.captureReplay.mu.Unlock()
	if !ok {
		return zero, false, nil
	}
	if entry.payloadDigest != digest {
		return zero, false, captureplane.IdempotencyConflictError{Operation: operation}
	}
	result, ok := entry.result.(T)
	if !ok {
		return zero, false, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "replay_type_mismatch", Retryable: false}
	}
	return result, true, nil
}

func captureReplayStore[T any](a Adapter, metadata captureplane.OperationMetadata, operation captureplane.OperationKind, input any, result T) error {
	key, digest, err := captureReplayIdentity(a, metadata, operation, input)
	if err != nil {
		return err
	}
	if a.captureReplay == nil {
		return nil
	}
	a.captureReplay.mu.Lock()
	defer a.captureReplay.mu.Unlock()
	if _, exists := a.captureReplay.entries[key]; !exists {
		if len(a.captureReplay.order) >= a.captureReplay.capacity {
			oldest := a.captureReplay.order[0]
			delete(a.captureReplay.entries, oldest)
			a.captureReplay.order = a.captureReplay.order[1:]
		}
		a.captureReplay.order = append(a.captureReplay.order, key)
	}
	a.captureReplay.entries[key] = captureReplayEntry{payloadDigest: digest, result: result}
	return nil
}

func captureTrackFailureCount(tracks []captureTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func captureCloseTrackFailureCount(tracks []captureCloseTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func captureDescription(value *captureplane.Description) *providerDescription {
	if value == nil {
		return nil
	}
	return &providerDescription{SDP: value.SDP, Type: value.Type}
}

func captureDescriptionValue(value *providerDescription) (*captureplane.Description, error) {
	if value == nil {
		return nil, nil
	}
	description := &captureplane.Description{SDP: value.SDP, Type: strings.TrimSpace(value.Type)}
	if err := description.Validate(); err != nil {
		return nil, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return description, nil
}

func captureProviderError(err error) error {
	if err == nil {
		return nil
	}
	var failure providerFailure
	if !errors.As(err, &failure) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "adapter_error", Retryable: true}
	}
	class := captureplane.ProviderFailureProtocol
	retryable := false
	switch {
	case failure.statusCode == http.StatusUnauthorized || failure.statusCode == http.StatusForbidden:
		class = captureplane.ProviderFailureUnauthorized
	case failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone:
		class = captureplane.ProviderFailureNotFound
	case failure.providerCode == "connection_not_found":
		class = captureplane.ProviderFailureNotFound
	case failure.statusCode == http.StatusTooManyRequests:
		class = captureplane.ProviderFailureRateLimited
		retryable = true
	case failure.stage == failureStageTransport || failure.statusCode >= 500 || failure.providerCode == "plane_unavailable":
		class = captureplane.ProviderFailureUnavailable
		retryable = true
	}
	code := strings.TrimSpace(failure.providerCode)
	if code == "" || code == "unknown" {
		code = "provider_failure"
	}
	return captureplane.ProviderError{Class: class, Code: code, Retryable: retryable}
}

func captureConnection(metadata captureplane.OperationMetadata, reference string) captureplane.CaptureConnection {
	return captureplane.CaptureConnection{
		ConnectionReference: captureplane.ProviderReference(reference),
		CaptureEpoch:        metadata.CaptureEpoch,
		PlanRevision:        metadata.PlanRevision,
	}
}

func captureNegotiationID(metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, operation captureplane.OperationKind, description *captureplane.Description) captureplane.ProviderReference {
	var descriptionType, descriptionSDP string
	if description != nil {
		descriptionType = description.Type
		descriptionSDP = description.SDP
	}
	hashInput := fmt.Sprintf("%s\x00%d\x00%d\x00%s\x00%s\x00%s", connection, metadata.CaptureEpoch, metadata.PlanRevision, operation, descriptionType, descriptionSDP)
	digest := sha256.Sum256([]byte(hashInput))
	return captureplane.ProviderReference("cf-neg-" + hex.EncodeToString(digest[:16]))
}

func captureNegotiation(metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, operation captureplane.OperationKind, description *providerDescription, requires bool) (captureplane.Negotiation, error) {
	converted, err := captureDescriptionValue(description)
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	if converted == nil {
		if requires {
			return captureplane.Negotiation{
				ID:          captureNegotiationID(metadata, connection, operation, nil),
				Requirement: captureplane.NegotiationOfferNeeded,
			}, nil
		}
		return captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}, nil
	}
	switch converted.Type {
	case "offer":
		if !requires {
			return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		return captureplane.Negotiation{
			ID:          captureNegotiationID(metadata, connection, operation, converted),
			Requirement: captureplane.NegotiationAnswerNeeded,
			Description: converted,
		}, nil
	case "answer":
		if requires {
			return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		return captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: converted}, nil
	default:
		return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
}

func captureLayerRID(layer captureplane.TrackLayer) string {
	switch layer {
	case captureplane.TrackLayerHigh:
		return "h"
	case captureplane.TrackLayerMedium:
		return "m"
	case captureplane.TrackLayerLow:
		return "l"
	default:
		return ""
	}
}

func (a Adapter) CreateCaptureConnection(ctx context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureReplayLookup[captureplane.CreateCaptureConnectionResult](a, input.Metadata, captureplane.OperationCreateCaptureConnection, input); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	} else if replayed {
		return result, nil
	}
	var response captureCreateConnectionResponse
	if err := a.request(ctx, http.MethodPost, providerConnectionsPath+"/new", nil, &response, "create_connection"); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, captureProviderError(err)
	}
	reference, err := captureplane.NewProviderReference(strings.TrimSpace(response.ConnectionReference))
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	connection := captureConnection(input.Metadata, reference.String())
	negotiation, err := captureNegotiation(input.Metadata, reference, captureplane.OperationCreateCaptureConnection, response.Description, false)
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	result := captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationCreateCaptureConnection, input, result); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	return result, nil
}

func (a Adapter) PullCaptureTracks(ctx context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	tracks, err := captureplane.CanonicalizeCaptureTracks(input.Tracks)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	input.Tracks = tracks
	if result, replayed, err := captureReplayLookup[captureplane.PullCaptureTracksResult](a, input.Metadata, captureplane.OperationPullCaptureTracks, input); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	} else if replayed {
		return result, nil
	}
	requestTracks := make([]captureTrackRequest, 0, len(tracks))
	for _, track := range tracks {
		providerTrack := captureTrackRequest{
			providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: track.OwnerReference.String()},
			Location:                   "remote",
			TrackName:                  track.TrackReference.String(),
			Kind:                       track.Kind.String(),
		}
		if rid := captureLayerRID(track.RequestedLayer); rid != "" {
			providerTrack.Simulcast = &captureSimulcast{PreferredRID: rid}
		}
		requestTracks = append(requestTracks, providerTrack)
	}
	request := captureTracksRequest{providerDescriptionEnvelope: providerDescriptionEnvelope{Description: captureDescription(input.LocalDescription)}, Tracks: requestTracks, AutoDiscover: false}
	var response captureTracksResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/new", url.PathEscape(input.Connection.String()))
	if err := a.request(ctx, http.MethodPost, path, request, &response, "add_tracks"); err != nil {
		return captureplane.PullCaptureTracksResult{}, captureProviderError(err)
	}
	if err := validateCapturePullResponse(response, tracks); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	byIdentity := make(map[captureTrackKey]captureTrackResult, len(response.Tracks))
	for _, result := range response.Tracks {
		byIdentity[captureTrackKey{owner: result.ConnectionReference, track: result.TrackName}] = result
	}
	pulled := make([]captureplane.PulledCaptureTrack, 0, len(tracks))
	for _, track := range tracks {
		result := byIdentity[captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}]
		mid, err := captureplane.NewProviderReference(strings.TrimSpace(result.Mid))
		if err != nil {
			return captureplane.PullCaptureTracksResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		pulledTrack := captureplane.PulledCaptureTrack{CaptureTrack: track, MID: mid}
		pulled = append(pulled, pulledTrack)
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationPullCaptureTracks, response.Description, response.RequiresImmediateRenegotiation)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	result := captureplane.PullCaptureTracksResult{Connection: captureConnection(input.Metadata, input.Connection.String()), Tracks: pulled, Negotiation: negotiation}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationPullCaptureTracks, input, result); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	return result, nil
}

func validateCapturePullResponse(response captureTracksResponse, tracks []captureplane.CaptureTrack) error {
	requested := make(map[captureTrackKey]struct{}, len(tracks))
	for _, track := range tracks {
		requested[captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}] = struct{}{}
	}
	seen := make(map[captureTrackKey]struct{}, len(response.Tracks))
	seenMIDs := make(map[string]struct{}, len(response.Tracks))
	for _, result := range response.Tracks {
		key := captureTrackKey{owner: strings.TrimSpace(result.ConnectionReference), track: strings.TrimSpace(result.TrackName)}
		if result.Location != "" && result.Location != "remote" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, ok := requested[key]; !ok || key.owner == "" || key.track == "" || strings.TrimSpace(result.Mid) == "" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seen[key]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		mid := strings.TrimSpace(result.Mid)
		if _, duplicate := seenMIDs[mid]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		seen[key] = struct{}{}
		seenMIDs[mid] = struct{}{}
	}
	if len(seen) != len(requested) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return nil
}

func (a Adapter) RenegotiateCaptureConnection(ctx context.Context, input captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureReplayLookup[captureplane.RenegotiateCaptureConnectionResult](a, input.Metadata, captureplane.OperationRenegotiateCaptureConnection, input); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	} else if replayed {
		return result, nil
	}
	request := captureRenegotiateRequest{providerDescriptionEnvelope: providerDescriptionEnvelope{Description: &providerDescription{SDP: input.Description.SDP, Type: input.Description.Type}}}
	var response captureRenegotiateResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s/renegotiate", url.PathEscape(input.Connection.String()))
	if err := a.request(ctx, http.MethodPut, path, request, &response, "renegotiate"); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, captureProviderError(err)
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationRenegotiateCaptureConnection, response.Description, false)
	if err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	result := captureplane.RenegotiateCaptureConnectionResult{Connection: captureConnection(input.Metadata, input.Connection.String()), Negotiation: negotiation}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationRenegotiateCaptureConnection, input, result); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	return result, nil
}

func (a Adapter) InspectCaptureConnection(ctx context.Context, input captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	canonical, err := captureplane.CanonicalizeInspectCaptureConnectionInput(input)
	if err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	input = canonical
	if result, replayed, err := captureReplayLookup[captureplane.InspectCaptureConnectionResult](a, input.Metadata, captureplane.OperationInspectCaptureConnection, input); err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	} else if replayed {
		return result, nil
	}
	response, err := a.inspectCaptureConnection(ctx, input.Connection)
	if err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	authoritative := make(map[string]captureplane.PulledCaptureTrack, len(input.Tracks))
	for _, track := range input.Tracks {
		authoritative[track.MID.String()] = track
	}
	observed := make([]captureplane.ObservedCaptureTrack, 0, len(response.Tracks))
	seenMIDs := make(map[string]struct{}, len(response.Tracks))
	active := false
	waiting := false
	for _, result := range response.Tracks {
		switch result.Status {
		case "active":
			active = true
		case "waiting":
			waiting = true
		case "inactive":
		default:
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		mid, err := captureplane.NewProviderReference(strings.TrimSpace(result.Mid))
		if err != nil {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seenMIDs[mid.String()]; duplicate {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		seenMIDs[mid.String()] = struct{}{}
		track, ok := authoritative[mid.String()]
		if !ok {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if owner := strings.TrimSpace(result.ConnectionReference); owner != "" && owner != track.OwnerReference.String() {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if name := strings.TrimSpace(result.TrackName); name != "" && name != track.TrackReference.String() {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		observed = append(observed, captureplane.ObservedCaptureTrack{PulledCaptureTrack: track, Active: result.Status == "active"})
	}
	if len(seenMIDs) != len(authoritative) {
		return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	state := captureplane.CaptureConnectionConnecting
	switch {
	case active:
		state = captureplane.CaptureConnectionConnected
	case waiting:
		state = captureplane.CaptureConnectionConnecting
	case len(response.Tracks) > 0:
		state = captureplane.CaptureConnectionDisconnected
	}
	result := captureplane.InspectCaptureConnectionResult{Connection: captureConnection(input.Metadata, input.Connection.String()), State: state, Tracks: observed, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationInspectCaptureConnection, input, result); err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	return result, nil
}

func (a Adapter) inspectCaptureConnection(ctx context.Context, connection captureplane.ProviderReference) (captureInspectResponse, error) {
	var response captureInspectResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s", url.PathEscape(connection.String()))
	if err := a.request(ctx, http.MethodGet, path, nil, &response, "verify_connection"); err != nil {
		return captureInspectResponse{}, captureProviderError(err)
	}
	for index := range response.Tracks {
		response.Tracks[index].Status = strings.ToLower(strings.TrimSpace(response.Tracks[index].Status))
		if response.Tracks[index].Status != "active" && response.Tracks[index].Status != "inactive" && response.Tracks[index].Status != "waiting" {
			return captureInspectResponse{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if strings.TrimSpace(response.Tracks[index].Mid) == "" {
			return captureInspectResponse{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
	}
	return response, nil
}

func (a Adapter) CloseCaptureTracks(ctx context.Context, input captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	tracks, err := captureplane.CanonicalizePulledCaptureTracks(input.Tracks)
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	input.Tracks = tracks
	if result, replayed, err := captureReplayLookup[captureplane.CloseCaptureTracksResult](a, input.Metadata, captureplane.OperationCloseCaptureTracks, input); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	} else if replayed {
		return result, nil
	}
	closeTracks := make([]captureCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closeTracks = append(closeTracks, captureCloseTrack{Mid: track.MID.String()})
	}
	request := captureCloseTracksRequest{Tracks: closeTracks, Force: true}
	var response captureCloseTracksResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/close", url.PathEscape(input.Connection.String()))
	if err := a.request(ctx, http.MethodPut, path, request, &response, "close_tracks"); err != nil {
		return captureplane.CloseCaptureTracksResult{}, captureProviderError(err)
	}
	if err := validateCaptureCloseResponse(response, closeTracks); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationCloseCaptureTracks, response.Description, response.RequiresImmediateRenegotiation)
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	result := captureplane.CloseCaptureTracksResult{Connection: captureConnection(input.Metadata, input.Connection.String()), Tracks: append([]captureplane.PulledCaptureTrack(nil), input.Tracks...), Negotiation: negotiation}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationCloseCaptureTracks, input, result); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	return result, nil
}

func validateCaptureCloseResponse(response captureCloseTracksResponse, requested []captureCloseTrack) error {
	wanted := make(map[string]struct{}, len(requested))
	for _, track := range requested {
		wanted[track.Mid] = struct{}{}
	}
	seen := make(map[string]struct{}, len(response.Tracks))
	for _, track := range response.Tracks {
		mid := strings.TrimSpace(track.Mid)
		if _, ok := wanted[mid]; !ok || mid == "" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seen[mid]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		seen[mid] = struct{}{}
		if (strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "") && !closedTrackAbsent(track.ErrorCode) {
			return captureProviderError(newProviderResponseFailure("close_tracks", failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(response.Tracks), captureCloseTrackFailureCount(response.Tracks)))
		}
	}
	if len(seen) != len(wanted) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return nil
}

func (a Adapter) CloseCaptureConnection(ctx context.Context, input captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	canonical, err := captureplane.CanonicalizeCloseCaptureConnectionInput(input)
	if err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	input = canonical
	if result, replayed, err := captureReplayLookup[captureplane.CloseCaptureConnectionResult](a, input.Metadata, captureplane.OperationCloseCaptureConnection, input); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	} else if replayed {
		return result, nil
	}
	if len(input.Tracks) > 0 && !input.Force {
		return captureplane.CloseCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "force_required", Retryable: false}
	}
	if len(input.Tracks) > 0 {
		closeTracks := make([]captureCloseTrack, 0, len(input.Tracks))
		for _, track := range input.Tracks {
			closeTracks = append(closeTracks, captureCloseTrack{Mid: track.MID.String()})
		}
		var closeResponse captureCloseTracksResponse
		path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/close", url.PathEscape(input.Connection.String()))
		if err := a.request(ctx, http.MethodPut, path, captureCloseTracksRequest{Tracks: closeTracks, Force: input.Force}, &closeResponse, "close_tracks"); err != nil {
			return captureplane.CloseCaptureConnectionResult{}, captureProviderError(err)
		}
		if err := validateCaptureCloseResponse(closeResponse, closeTracks); err != nil {
			return captureplane.CloseCaptureConnectionResult{}, err
		}
		if closeResponse.Description != nil || closeResponse.RequiresImmediateRenegotiation {
			return captureplane.CloseCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
	}
	result := captureplane.CloseCaptureConnectionResult{Connection: captureConnection(input.Metadata, input.Connection.String()), Closed: true}
	if err := captureReplayStore(a, input.Metadata, captureplane.OperationCloseCaptureConnection, input, result); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	return result, nil
}

var _ captureplane.CapturePlane = Adapter{}
