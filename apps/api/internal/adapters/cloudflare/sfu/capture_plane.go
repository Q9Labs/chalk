package sfu

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func (a Adapter) CreateCaptureConnection(ctx context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CreateCaptureConnectionResult](a.captureReplay, input.Metadata, captureplane.OperationCreateCaptureConnection, input); err != nil {
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
	connection := input.Metadata.Connection(reference)
	negotiation, err := captureNegotiation(input.Metadata, reference, captureplane.OperationCreateCaptureConnection, response.Description, false)
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	result := captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationCreateCaptureConnection, input, result); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	return result, nil
}

func (a Adapter) RenegotiateCaptureConnection(ctx context.Context, input captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.RenegotiateCaptureConnectionResult](a.captureReplay, input.Metadata, captureplane.OperationRenegotiateCaptureConnection, input); err != nil {
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
	result := captureplane.RenegotiateCaptureConnectionResult{Connection: input.Metadata.Connection(input.Connection), Negotiation: negotiation}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationRenegotiateCaptureConnection, input, result); err != nil {
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
	if result, replayed, err := captureplane.ReplayLookup[captureplane.InspectCaptureConnectionResult](a.captureReplay, input.Metadata, captureplane.OperationInspectCaptureConnection, input); err != nil {
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
		if result.Location != "remote" || result.ConnectionReference != track.OwnerReference.String() {
			return captureplane.InspectCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if result.TrackName != track.TrackReference.String() {
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
	result := captureplane.InspectCaptureConnectionResult{Connection: input.Metadata.Connection(input.Connection), State: state, Tracks: observed, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationInspectCaptureConnection, input, result); err != nil {
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
		response.Tracks[index].ConnectionReference = a.sessions.clientID(response.Tracks[index].ConnectionReference)
		if response.Tracks[index].Location != "remote" || response.Tracks[index].ConnectionReference == "" || response.Tracks[index].TrackName == "" {
			return captureInspectResponse{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if response.Tracks[index].Status != "active" && response.Tracks[index].Status != "inactive" && response.Tracks[index].Status != "waiting" {
			return captureInspectResponse{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if strings.TrimSpace(response.Tracks[index].Mid) == "" || strings.TrimSpace(response.Tracks[index].Mid) != response.Tracks[index].Mid {
			return captureInspectResponse{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
	}
	return response, nil
}
