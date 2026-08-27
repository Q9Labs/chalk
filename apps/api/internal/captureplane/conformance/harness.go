// Package conformance contains provider-neutral tests shared by CapturePlane
// adapters. Adapter packages supply a test transport and call Run from their
// *_test.go files.
package conformance

import (
	"context"
	"reflect"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// Reporter is implemented by testing.T and keeps this harness usable by
// adapters without making the production captureplane package depend on the
// testing package.
type Reporter interface {
	Helper()
	Errorf(string, ...any)
}

// Fixture supplies valid Chalk identity and publication references for a
// conformance run. Adapters may replace the local SDP with the shape their
// provider test transport accepts.
type Fixture struct {
	Metadata                 captureplane.OperationMetadata
	Tracks                   []captureplane.CaptureTrack
	LocalDescription         *captureplane.Description
	RenegotiationDescription captureplane.Description
}

// Run checks the six CapturePlane operations, result envelopes, operation
// fences, and retry idempotency. A pull result that fences an SDP exchange
// exercises RenegotiateCaptureConnection; apply-only provider answers do not.
func Run(t Reporter, plane captureplane.CapturePlane, fixture Fixture) {
	t.Helper()
	if plane == nil {
		t.Errorf("capture plane is nil")
		return
	}
	if err := fixture.Metadata.Identity.Validate(); err != nil {
		t.Errorf("fixture identity: %v", err)
		return
	}
	if err := fixture.Metadata.Validate(); err != nil {
		t.Errorf("fixture metadata: %v", err)
		return
	}
	if _, err := captureplane.CanonicalizeCaptureTracks(fixture.Tracks); err != nil {
		t.Errorf("fixture tracks: %v", err)
		return
	}

	ctx := context.Background()
	createInput := captureplane.CreateCaptureConnectionInput{Metadata: fixture.Metadata}
	if err := createInput.Validate(); err != nil {
		t.Errorf("CreateCaptureConnection input: %v", err)
		return
	}
	created, err := plane.CreateCaptureConnection(ctx, createInput)
	if err != nil {
		t.Errorf("CreateCaptureConnection: %v", err)
		return
	}
	if err := created.ValidateAgainst(fixture.Metadata); err != nil {
		t.Errorf("CreateCaptureConnection result: %v", err)
		return
	}
	createdRetry, err := plane.CreateCaptureConnection(ctx, createInput)
	if err != nil {
		t.Errorf("CreateCaptureConnection retry: %v", err)
		return
	}
	if !reflect.DeepEqual(created, createdRetry) {
		t.Errorf("CreateCaptureConnection retry returned a different result")
		return
	}
	if created.Connection.CaptureEpoch != fixture.Metadata.CaptureEpoch || created.Connection.PlanRevision != fixture.Metadata.PlanRevision {
		t.Errorf("created connection fence = epoch %d plan %d, want epoch %d plan %d", created.Connection.CaptureEpoch, created.Connection.PlanRevision, fixture.Metadata.CaptureEpoch, fixture.Metadata.PlanRevision)
		return
	}

	pullInput := captureplane.PullCaptureTracksInput{
		Metadata:         fixture.Metadata,
		Connection:       created.Connection.ConnectionReference,
		Tracks:           fixture.Tracks,
		LocalDescription: fixture.LocalDescription,
	}
	if err := pullInput.Validate(); err != nil {
		t.Errorf("PullCaptureTracks input: %v", err)
		return
	}
	pulled, err := plane.PullCaptureTracks(ctx, pullInput)
	if err != nil {
		t.Errorf("PullCaptureTracks: %v", err)
		return
	}
	if err := pulled.ValidateAgainst(fixture.Metadata); err != nil {
		t.Errorf("PullCaptureTracks result: %v", err)
		return
	}
	pulledRetry, err := plane.PullCaptureTracks(ctx, pullInput)
	if err != nil {
		t.Errorf("PullCaptureTracks retry: %v", err)
		return
	}
	if !reflect.DeepEqual(pulled, pulledRetry) {
		t.Errorf("PullCaptureTracks retry returned a different result")
		return
	}
	if len(pulled.Tracks) != len(fixture.Tracks) {
		t.Errorf("pulled track count = %d, want %d", len(pulled.Tracks), len(fixture.Tracks))
		return
	}
	if pulled.Negotiation.Requirement == captureplane.NegotiationAnswerNeeded || pulled.Negotiation.Requirement == captureplane.NegotiationOfferNeeded {
		renegotiateInput := captureplane.RenegotiateCaptureConnectionInput{
			Metadata:      fixture.Metadata,
			Connection:    created.Connection.ConnectionReference,
			NegotiationID: pulled.Negotiation.ID,
			Description:   fixture.RenegotiationDescription,
		}
		if err := renegotiateInput.Validate(); err != nil {
			t.Errorf("RenegotiateCaptureConnection input: %v", err)
			return
		}
		renegotiated, err := plane.RenegotiateCaptureConnection(ctx, renegotiateInput)
		if err != nil {
			t.Errorf("RenegotiateCaptureConnection: %v", err)
			return
		}
		if err := renegotiated.ValidateAgainst(fixture.Metadata); err != nil {
			t.Errorf("RenegotiateCaptureConnection result: %v", err)
			return
		}
		renegotiatedRetry, err := plane.RenegotiateCaptureConnection(ctx, renegotiateInput)
		if err != nil {
			t.Errorf("RenegotiateCaptureConnection retry: %v", err)
			return
		}
		if !reflect.DeepEqual(renegotiated, renegotiatedRetry) {
			t.Errorf("RenegotiateCaptureConnection retry returned a different result")
			return
		}
	}

	inspectInput := captureplane.InspectCaptureConnectionInput{Metadata: fixture.Metadata, Connection: created.Connection.ConnectionReference, Tracks: pulled.Tracks}
	if err := inspectInput.Validate(); err != nil {
		t.Errorf("InspectCaptureConnection input: %v", err)
		return
	}
	inspected, err := plane.InspectCaptureConnection(ctx, inspectInput)
	if err != nil {
		t.Errorf("InspectCaptureConnection: %v", err)
		return
	}
	if err := inspected.ValidateAgainst(fixture.Metadata); err != nil {
		t.Errorf("InspectCaptureConnection result: %v", err)
		return
	}

	closeTracksInput := captureplane.CloseCaptureTracksInput{Metadata: fixture.Metadata, Connection: created.Connection.ConnectionReference, Tracks: pulled.Tracks}
	if err := closeTracksInput.Validate(); err != nil {
		t.Errorf("CloseCaptureTracks input: %v", err)
		return
	}
	closedTracks, err := plane.CloseCaptureTracks(ctx, closeTracksInput)
	if err != nil {
		t.Errorf("CloseCaptureTracks: %v", err)
		return
	}
	if err := closedTracks.ValidateAgainst(fixture.Metadata); err != nil {
		t.Errorf("CloseCaptureTracks result: %v", err)
		return
	}
	closedTracksRetry, err := plane.CloseCaptureTracks(ctx, closeTracksInput)
	if err != nil {
		t.Errorf("CloseCaptureTracks retry: %v", err)
		return
	}
	if !reflect.DeepEqual(closedTracks, closedTracksRetry) {
		t.Errorf("CloseCaptureTracks retry returned a different result")
		return
	}

	closeConnectionInput := captureplane.CloseCaptureConnectionInput{Metadata: fixture.Metadata, Connection: created.Connection.ConnectionReference, Tracks: pulled.Tracks, Force: true}
	if err := closeConnectionInput.Validate(); err != nil {
		t.Errorf("CloseCaptureConnection input: %v", err)
		return
	}
	closedConnection, err := plane.CloseCaptureConnection(ctx, closeConnectionInput)
	if err != nil {
		t.Errorf("CloseCaptureConnection: %v", err)
		return
	}
	if err := closedConnection.ValidateAgainst(fixture.Metadata); err != nil {
		t.Errorf("CloseCaptureConnection result: %v", err)
		return
	}
	if !closedConnection.Closed {
		t.Errorf("CloseCaptureConnection result is not closed")
		return
	}
	closedConnectionRetry, err := plane.CloseCaptureConnection(ctx, closeConnectionInput)
	if err != nil {
		t.Errorf("CloseCaptureConnection retry: %v", err)
		return
	}
	if !reflect.DeepEqual(closedConnection, closedConnectionRetry) {
		t.Errorf("CloseCaptureConnection retry returned a different result")
	}
}
