package recordercapture

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var coordinatorNow = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

type fakePeer struct {
	registered      []captureplane.PulledCaptureTrack
	registrations   [][]captureplane.PulledCaptureTrack
	answer          captureplane.Description
	offer           captureplane.Negotiation
	createdOfferIDs []captureplane.ProviderReference
	appliedAnswers  []captureplane.Negotiation
}

func (p *fakePeer) RegisterTracks(tracks []captureplane.PulledCaptureTrack) error {
	p.registered = append(p.registered[:0], tracks...)
	p.registrations = append(p.registrations, append([]captureplane.PulledCaptureTrack(nil), tracks...))
	return nil
}

func registrationSizes(registrations [][]captureplane.PulledCaptureTrack) []int {
	sizes := make([]int, len(registrations))
	for index := range registrations {
		sizes[index] = len(registrations[index])
	}
	return sizes
}

func (p *fakePeer) CreateLocalOffer(_ context.Context, ids ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	if len(ids) != 1 {
		return captureplane.Negotiation{}, fmt.Errorf("provider ID missing")
	}
	p.createdOfferIDs = append(p.createdOfferIDs, ids[0])
	offer := p.offer
	offer.ID = ids[0]
	return offer, nil
}

func (p *fakePeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return p.answer, nil
}

func (p *fakePeer) ApplyRemoteAnswer(_ context.Context, negotiation captureplane.Negotiation) error {
	p.appliedAnswers = append(p.appliedAnswers, negotiation)
	return nil
}

type fakeSignaling struct {
	operations       []captureplane.OperationKind
	keys             []string
	renegotiateIDs   []captureplane.ProviderReference
	pullNegotiation  captureplane.Negotiation
	closeNegotiation captureplane.Negotiation
	renegotiation    []captureplane.Negotiation
	repeatOffer      bool
	pullCount        int
	pullGone         bool
	pullUnavailable  int
	leases           []time.Time
	wrongKey         bool
}

func (s *fakeSignaling) Execute(_ context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	command := request.Command
	s.leases = append(s.leases, command.Lease.ExpiresAt)
	s.operations = append(s.operations, command.Identity.Operation)
	s.keys = append(s.keys, command.Identity.IdempotencyKey)
	metadata := captureplane.OperationMetadata{Identity: captureplane.CaptureIdentity{TenantID: command.Authority.TenantID, SpaceID: command.Authority.SpaceID, EpisodeID: command.Authority.EpisodeID, RecordingID: command.Authority.RecordingID}, CaptureEpoch: command.Authority.CaptureEpoch, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey}
	key := capturesignaling.CommandKey{SignalingHandle: command.SignalingHandle, Operation: command.Identity.Operation, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey}
	if s.wrongKey {
		key.IdempotencyKey = "wrong-key"
	}
	connection := captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: metadata.CaptureEpoch, PlanRevision: metadata.PlanRevision}
	switch command.Identity.Operation {
	case captureplane.OperationCreateCaptureConnection:
		return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{CreateCaptureConnection: &captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}}}, nil
	case captureplane.OperationPullCaptureTracks:
		s.pullCount++
		input := command.Input.PullCaptureTracks
		if s.pullUnavailable > 0 {
			s.pullUnavailable--
			return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{Connection: connection, Unavailable: append([]captureplane.CaptureTrack(nil), input.Tracks...), Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}}}, nil
		}
		if s.pullGone {
			return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{
				Connection: connection, Gone: append([]captureplane.CaptureTrack(nil), input.Tracks...),
				Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
			}}}, nil
		}
		pulled := make([]captureplane.PulledCaptureTrack, len(input.Tracks))
		for i, track := range input.Tracks {
			pulled[i] = captureplane.PulledCaptureTrack{CaptureTrack: track, MID: captureplane.ProviderReference(fmt.Sprintf("mid-%s", track.TrackReference))}
		}
		negotiation := s.pullNegotiation
		if negotiation.Requirement == "" {
			negotiation = captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
		}
		return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{Connection: connection, Tracks: pulled, Negotiation: negotiation}}}, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		input := command.Input.RenegotiateCaptureConnection
		s.renegotiateIDs = append(s.renegotiateIDs, input.NegotiationID)
		negotiation := captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
		if s.repeatOffer {
			negotiation = captureplane.Negotiation{ID: captureplane.ProviderReference(fmt.Sprintf("provider-%d", len(s.renegotiateIDs))), Requirement: captureplane.NegotiationOfferNeeded}
		} else if len(s.renegotiation) > 0 {
			negotiation = s.renegotiation[0]
			s.renegotiation = s.renegotiation[1:]
		}
		return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}}}, nil
	case captureplane.OperationCloseCaptureTracks:
		negotiation := s.closeNegotiation
		if negotiation.Requirement == "" {
			negotiation = captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
		}
		return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{CloseCaptureTracks: &captureplane.CloseCaptureTracksResult{Connection: connection, Tracks: append([]captureplane.PulledCaptureTrack(nil), command.Input.CloseCaptureTracks.Tracks...), Negotiation: negotiation}}}, nil
	case captureplane.OperationCloseCaptureConnection:
		return capturesignaling.Execution{Key: key, Result: capturesignaling.CommandResult{CloseCaptureConnection: &captureplane.CloseCaptureConnectionResult{Connection: connection, Closed: true}}}, nil
	default:
		return capturesignaling.Execution{}, fmt.Errorf("unexpected operation %s", command.Identity.Operation)
	}
}

func newCoordinator(t *testing.T, authority AttemptAuthority, signaling SignalingPort, peer PeerPort, config Config) *Coordinator {
	t.Helper()
	if config.Now == nil {
		config.Now = func() time.Time { return coordinatorNow }
	}
	coordinator, err := NewCoordinator(authority, signaling, peer, config)
	if err != nil {
		t.Fatalf("new coordinator: %v", err)
	}
	return coordinator
}

func newAttempt(t *testing.T) AttemptAuthority {
	t.Helper()
	tenant := mustID(t, "11111111-1111-4111-8111-111111111111")
	space := mustID(t, "22222222-2222-4222-8222-222222222222")
	episode := mustID(t, "33333333-3333-4333-8333-333333333333")
	recording := mustID(t, "44444444-4444-4444-8444-444444444444")
	jobID := mustID(t, "55555555-5555-4555-8555-555555555555")
	claimID := mustID(t, "77777777-7777-4777-8777-777777777777")
	authority, err := recordingpipeline.NewRecorderJobAuthority(recordingpipeline.Job{ID: jobID, TenantID: tenant, EpisodeID: episode, RecordingID: recording, Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, FencingGeneration: 1}, recordingpipeline.ClaimFacts{SpaceID: space, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: coordinatorNow.Add(time.Hour), CaptureEpoch: 1}, claimID, coordinatorNow)
	if err != nil {
		t.Fatalf("job authority: %v", err)
	}
	attempt, err := NewAttemptAuthorityAt(authority.Envelope, authority.EnvelopeDigest, capturesignaling.WorkerLease{Owner: "worker-1", Token: "lease-1", ExpiresAt: coordinatorNow.Add(time.Hour)}, coordinatorNow)
	if err != nil {
		t.Fatalf("attempt authority: %v", err)
	}
	return attempt
}

type planTrack struct{ name string }

func newPlan(t *testing.T, attempt AttemptAuthority, revision captureplane.PlanRevision, tracks []planTrack) captureplan.Plan {
	return newPlanWithDeadline(t, attempt, revision, tracks, coordinatorNow.Add(time.Hour))
}

func newPlanWithDeadline(t *testing.T, attempt AttemptAuthority, revision captureplane.PlanRevision, tracks []planTrack, deadline time.Time) captureplan.Plan {
	t.Helper()
	participant := captureplan.ParticipantSnapshot{ID: mustID(t, "88888888-8888-4888-8888-888888888888"), Generation: 1, DisplayName: "Participant", JoinOrdinal: 1, Lifecycle: captureplan.ParticipantActive}
	planTracks := make([]captureplan.TrackSnapshot, len(tracks))
	for i, track := range tracks {
		planTracks[i] = captureplan.TrackSnapshot{ParticipantID: participant.ID, ParticipantGeneration: participant.Generation, Source: captureplane.TrackSourceCamera, Kind: captureplane.TrackKindVideo, OwnerReference: captureplane.ProviderReference("owner-" + track.name), TrackReference: captureplane.ProviderReference("track-" + track.name), OwnerMID: captureplane.ProviderReference("owner-mid-" + track.name), PublicationReference: captureplan.PublicationReference("publication-" + track.name), RequestedLayer: captureplane.TrackLayerAuto}
	}
	plan, err := captureplan.NewPlan(captureplan.PlanInput{Authority: captureplan.PlanAuthority{PlanHandle: attempt.PlanHandle, TenantID: attempt.TenantID, SpaceID: attempt.SpaceID, EpisodeID: attempt.EpisodeID, RecordingID: attempt.RecordingID, JobID: attempt.JobID, AttemptCount: attempt.AttemptCount, FencingGeneration: attempt.FencingGeneration, CaptureEpoch: attempt.CaptureEpoch, EnvelopeDigest: append([]byte(nil), attempt.EnvelopeDigest...)}, Revision: revision, Cursors: captureplan.PlanCursors{EpisodeControlRevision: int64(revision), ProviderIncarnation: 1, ProviderSequence: int64(revision)}, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4_000_000, EffectiveDeadline: deadline, StopState: captureplan.StopStateRunning, Participants: []captureplan.ParticipantSnapshot{participant}, Tracks: planTracks})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	return plan
}

func answerNeeded(id captureplane.ProviderReference) captureplane.Negotiation {
	return captureplane.Negotiation{ID: id, Requirement: captureplane.NegotiationAnswerNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}
}

func offerNeeded(id captureplane.ProviderReference) captureplane.Negotiation {
	return captureplane.Negotiation{ID: id, Requirement: captureplane.NegotiationOfferNeeded}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse ID: %v", err)
	}
	return id
}

func digestEnvelope(t *testing.T, envelope recordingpipeline.RecorderJobEnvelope) []byte {
	t.Helper()
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	digest := sha256.Sum256(encoded)
	return digest[:]
}

func indexOfOperation(operations []captureplane.OperationKind, wanted captureplane.OperationKind) int {
	for index, operation := range operations {
		if operation == wanted {
			return index
		}
	}
	return -1
}

func lastIndexOfOperation(operations []captureplane.OperationKind, wanted captureplane.OperationKind) int {
	for index := len(operations) - 1; index >= 0; index-- {
		if operations[index] == wanted {
			return index
		}
	}
	return -1
}

func countOperation(operations []captureplane.OperationKind, wanted captureplane.OperationKind) int {
	count := 0
	for _, operation := range operations {
		if operation == wanted {
			count++
		}
	}
	return count
}
