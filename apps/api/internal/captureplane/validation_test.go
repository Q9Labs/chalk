package captureplane

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestOperationValidationRequiresCompleteFence(t *testing.T) {
	metadata := validMetadata()
	if err := metadata.Validate(); err != nil {
		t.Fatalf("valid metadata: %v", err)
	}
	cases := []struct {
		name string
		edit func(*OperationMetadata)
		want error
	}{
		{name: "identity", edit: func(input *OperationMetadata) { input.Identity.EpisodeID = utilities.ID{} }, want: ErrInvalidIdentity},
		{name: "epoch", edit: func(input *OperationMetadata) { input.CaptureEpoch = 0 }, want: ErrInvalidCaptureEpoch},
		{name: "plan revision", edit: func(input *OperationMetadata) { input.PlanRevision = 0 }, want: ErrInvalidPlanRevision},
		{name: "blank key", edit: func(input *OperationMetadata) { input.IdempotencyKey = " " }, want: ErrInvalidIdempotencyKey},
		{name: "leading whitespace key", edit: func(input *OperationMetadata) { input.IdempotencyKey = " key" }, want: ErrInvalidIdempotencyKey},
		{name: "long key", edit: func(input *OperationMetadata) { input.IdempotencyKey = strings.Repeat("k", MaxIdempotencyKeyBytes+1) }, want: ErrInvalidIdempotencyKey},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := metadata
			test.edit(&input)
			err := input.Validate()
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want invalid input wrapper", err)
			}
		})
	}
}

func TestCanonicalizeTracksSortsAndRejectsConflicts(t *testing.T) {
	first := validTrack(3, TrackSourceCamera, TrackKindVideo, TrackLayerHigh, "owner-b", "track-b")
	second := validTrack(2, TrackSourceMicrophone, TrackKindAudio, TrackLayerAuto, "owner-a", "track-a")
	canonical, err := CanonicalizeCaptureTracks([]CaptureTrack{first, second})
	if err != nil {
		t.Fatalf("canonicalize tracks: %v", err)
	}
	if canonical[0].ParticipantID.String() >= canonical[1].ParticipantID.String() {
		t.Fatalf("tracks were not sorted by participant: %#v", canonical)
	}
	if canonical[0].TrackReference != second.TrackReference {
		t.Fatalf("first track = %#v, want microphone track", canonical[0])
	}

	duplicate := append([]CaptureTrack(nil), canonical...)
	duplicate = append(duplicate, canonical[0])
	if err := validateTracks(duplicate); !errors.Is(err, ErrDuplicateTrack) {
		t.Fatalf("duplicate error = %v", err)
	}

	bad := validTrack(4, TrackSourceMicrophone, TrackKindVideo, TrackLayerAuto, "owner-c", "track-c")
	if err := bad.Validate(); !errors.Is(err, ErrInvalidTrack) {
		t.Fatalf("source-kind error = %v", err)
	}
	bad = validTrack(4, TrackSourceCamera, TrackKindVideo, TrackLayerAuto, "owner-c", "track-c")
	if err := bad.Validate(); err != nil {
		t.Fatalf("auto video track: %v", err)
	}
	bad = validTrack(4, TrackSourceMicrophone, TrackKindAudio, TrackLayerLow, "owner-c", "track-c")
	if err := bad.Validate(); !errors.Is(err, ErrInvalidTrack) {
		t.Fatalf("audio layer error = %v", err)
	}
}

func TestValidationRejectsProviderWhitespaceAndInvalidNegotiation(t *testing.T) {
	if _, err := NewProviderReference(" provider"); !errors.Is(err, ErrInvalidProviderRef) {
		t.Fatalf("provider ref error = %v", err)
	}
	if err := (Description{Type: "offer", SDP: " offer"}).Validate(); !errors.Is(err, ErrInvalidDescription) {
		t.Fatalf("SDP error = %v", err)
	}
	negotiation := Negotiation{Requirement: NegotiationAnswerNeeded, Description: &Description{Type: "offer", SDP: "v=0"}}
	if err := negotiation.Validate(); !errors.Is(err, ErrInvalidNegotiation) {
		t.Fatalf("missing negotiation id error = %v", err)
	}
	negotiation.ID = ProviderReference("neg-1")
	if err := negotiation.Validate(); err != nil {
		t.Fatalf("valid negotiation: %v", err)
	}
	remoteAnswer := Negotiation{Requirement: NegotiationRemoteAnswer, Description: &Description{Type: "answer", SDP: "v=0"}}
	if err := remoteAnswer.Validate(); err != nil {
		t.Fatalf("valid remote answer: %v", err)
	}
	if err := (Negotiation{Requirement: NegotiationRemoteAnswer, Description: &Description{Type: "offer", SDP: "v=0"}}).Validate(); !errors.Is(err, ErrInvalidNegotiation) {
		t.Fatalf("remote answer offer error = %v", err)
	}
	if err := (Negotiation{ID: "neg-1", Requirement: NegotiationOfferNeeded}).Validate(); err != nil {
		t.Fatalf("offer-needed without description: %v", err)
	}
	if err := (Negotiation{ID: "neg-1", Requirement: NegotiationOfferNeeded, Description: &Description{Type: "answer", SDP: "v=0"}}).Validate(); !errors.Is(err, ErrInvalidNegotiation) {
		t.Fatalf("offer-needed answer error = %v", err)
	}
	if err := (Negotiation{ID: "neg-1", Requirement: NegotiationAnswerNeeded, Description: &Description{Type: "answer", SDP: "v=0"}}).Validate(); !errors.Is(err, ErrInvalidNegotiation) {
		t.Fatalf("answer-needed answer error = %v", err)
	}
}

func TestPulledTrackInputsPreserveAuthoritativeMIDs(t *testing.T) {
	metadata := validMetadata()
	pulled := PulledCaptureTrack{CaptureTrack: validTrack(4, TrackSourceCamera, TrackKindVideo, TrackLayerHigh, "owner-1", "track-1"), MID: "mid-1"}
	inspect := InspectCaptureConnectionInput{Metadata: metadata, Connection: "connection-1", Tracks: []PulledCaptureTrack{pulled}}
	if _, err := CanonicalizeInspectCaptureConnectionInput(inspect); err != nil {
		t.Fatalf("inspect pulled tracks: %v", err)
	}
	closeTracks := CloseCaptureTracksInput{Metadata: metadata, Connection: "connection-1", Tracks: []PulledCaptureTrack{pulled}}
	if _, err := CanonicalizeCloseCaptureTracksInput(closeTracks); err != nil {
		t.Fatalf("close pulled tracks: %v", err)
	}
	closeConnection := CloseCaptureConnectionInput{Metadata: metadata, Connection: "connection-1", Tracks: []PulledCaptureTrack{pulled}, Force: true}
	if _, err := CanonicalizeCloseCaptureConnectionInput(closeConnection); err != nil {
		t.Fatalf("close connection pulled tracks: %v", err)
	}
	if _, err := CanonicalizeCloseCaptureTracksInput(CloseCaptureTracksInput{Metadata: metadata, Connection: "connection-1", Tracks: []PulledCaptureTrack{{CaptureTrack: pulled.CaptureTrack, MID: ""}}}); !errors.Is(err, ErrInvalidTrack) {
		t.Fatalf("missing MID error = %v", err)
	}
}

func TestDescriptionPreservesWebRTCTermination(t *testing.T) {
	description := Description{Type: "offer", SDP: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"}
	if err := description.Validate(); err != nil {
		t.Fatalf("terminated SDP rejected: %v", err)
	}
	if description.SDP != "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" {
		t.Fatalf("SDP changed during validation: %q", description.SDP)
	}
}

func TestFencedErrorsExposeTypedReasonsWithoutProviderDetails(t *testing.T) {
	err := NewFencedError(OperationPullCaptureTracks, FencedByCaptureEpoch, 2, 1, 4, 4)
	if !errors.Is(err, ErrFenced) || !errors.Is(err, ErrStaleCaptureEpoch) {
		t.Fatalf("fenced error = %v", err)
	}
	if errors.Is(err, ErrStalePlanRevision) {
		t.Fatal("capture epoch fence was reported as plan revision fence")
	}
	var fenced *FencedError
	if !errors.As(err, &fenced) || fenced.ExpectedCaptureEpoch != 2 || fenced.ActualCaptureEpoch != 1 {
		t.Fatalf("fenced details = %#v", err)
	}

	providerErr := ProviderError{Class: ProviderFailureRateLimited, Code: "rate_limited", Retryable: true}
	if !errors.Is(providerErr, ErrProviderFailure) {
		t.Fatal("provider error does not unwrap to provider failure")
	}
}

func TestIdempotencyScopeIncludesOperationFence(t *testing.T) {
	metadata := validMetadata()
	first, err := metadata.IdempotencyScope(OperationPullCaptureTracks)
	if err != nil {
		t.Fatalf("first scope: %v", err)
	}
	second, err := metadata.IdempotencyScope(OperationPullCaptureTracks)
	if err != nil {
		t.Fatalf("second scope: %v", err)
	}
	if first != second {
		t.Fatal("same operation scope is not stable")
	}
	metadata.PlanRevision++
	changed, err := metadata.IdempotencyScope(OperationPullCaptureTracks)
	if err != nil {
		t.Fatalf("changed scope: %v", err)
	}
	if first == changed {
		t.Fatal("plan revision did not change operation scope")
	}
	metadata = validMetadata()
	changed, err = metadata.IdempotencyScope(OperationCloseCaptureTracks)
	if err != nil {
		t.Fatalf("changed operation scope: %v", err)
	}
	if first == changed {
		t.Fatal("operation kind did not change operation scope")
	}
}

func TestResultFenceValidationRejectsStaleProviderResult(t *testing.T) {
	metadata := validMetadata()
	result := CreateCaptureConnectionResult{
		Connection: CaptureConnection{
			ConnectionReference: ProviderReference("connection-1"),
			CaptureEpoch:        metadata.CaptureEpoch + 1,
			PlanRevision:        metadata.PlanRevision,
		},
		Negotiation: Negotiation{Requirement: NegotiationNotRequired},
	}
	err := result.ValidateAgainst(metadata)
	if !errors.Is(err, ErrFenced) || !errors.Is(err, ErrStaleCaptureEpoch) {
		t.Fatalf("stale result error = %v", err)
	}
}

func validMetadata() OperationMetadata {
	return OperationMetadata{
		Identity: CaptureIdentity{
			TenantID:    utilities.IDFromBytes([16]byte{1}),
			SpaceID:     utilities.IDFromBytes([16]byte{2}),
			EpisodeID:   utilities.IDFromBytes([16]byte{3}),
			RecordingID: utilities.IDFromBytes([16]byte{4}),
		},
		CaptureEpoch: 1, PlanRevision: 1, IdempotencyKey: "capture-test-1",
	}
}

func validTrack(participantByte byte, source TrackSource, kind TrackKind, layer TrackLayer, owner, track string) CaptureTrack {
	return CaptureTrack{
		OwnerReference:        ProviderReference(owner),
		TrackReference:        ProviderReference(track),
		ParticipantID:         utilities.IDFromBytes([16]byte{participantByte}),
		ParticipantGeneration: 1,
		Source:                source,
		Kind:                  kind,
		RequestedLayer:        layer,
	}
}
