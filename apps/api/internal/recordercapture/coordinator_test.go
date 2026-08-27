package recordercapture

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
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

func TestNewAttemptAuthorityAndPlanFence(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	if err := attempt.validatePlan(plan); err != nil {
		t.Fatalf("validate plan: %v", err)
	}
	badAuthority := plan.Authority()
	badAuthority.CaptureEpoch++
	badPlan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: badAuthority, Revision: 1,
		LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10,
		InputBitrateBPS: 4_000_000, EffectiveDeadline: coordinatorNow.Add(time.Hour),
		StopState:    captureplan.StopStateRunning,
		Participants: plan.Participants(), Tracks: plan.Tracks(),
	})
	if err != nil {
		t.Fatalf("bad plan: %v", err)
	}
	if !errors.Is(attempt.validatePlan(badPlan), ErrAuthorityMismatch) {
		t.Fatalf("expected authority mismatch")
	}
	deadlinePlan := newPlanWithDeadline(t, attempt, 1, []planTrack{{name: "one"}}, coordinatorNow.Add(2*time.Hour))
	if !errors.Is(attempt.validatePlan(deadlinePlan), ErrDeadlineMismatch) {
		t.Fatalf("expected deadline mismatch")
	}

	for name, edit := range map[string]func(*recordingpipeline.RecorderJobEnvelope){
		"padded tenant": func(envelope *recordingpipeline.RecorderJobEnvelope) { envelope.TenantID = " " + envelope.TenantID },
		"uppercase tenant": func(envelope *recordingpipeline.RecorderJobEnvelope) {
			envelope.TenantID = "A1111111-a111-4111-8111-111111111111"
		},
		"malformed deadline": func(envelope *recordingpipeline.RecorderJobEnvelope) { envelope.HardDeadline = "not-a-time" },
		"expired deadline": func(envelope *recordingpipeline.RecorderJobEnvelope) {
			envelope.HardDeadline = coordinatorNow.Format(time.RFC3339Nano)
		},
	} {
		t.Run(name, func(t *testing.T) {
			envelope := attempt.Envelope
			edit(&envelope)
			if _, err := NewAttemptAuthorityAt(envelope, digestEnvelope(t, envelope), attempt.Lease, coordinatorNow); !errors.Is(err, ErrInvalidAuthority) {
				t.Fatalf("error = %v, want invalid authority", err)
			}
		})
	}
}

func TestCoordinatorBootstrapAnswerAndProviderFence(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: answerNeeded("provider-offer")}
	peer := &fakePeer{answer: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 1})
	got, err := coordinator.Bootstrap(context.Background(), plan)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if len(got.Tracks) != 1 || len(peer.registered) != 1 {
		t.Fatalf("tracks = %#v, registered = %#v", got.Tracks, peer.registered)
	}
	if len(signaling.renegotiateIDs) != 1 || signaling.renegotiateIDs[0] != "provider-offer" {
		t.Fatalf("renegotiation IDs = %#v", signaling.renegotiateIDs)
	}
	if signaling.operations[0] != captureplane.OperationCreateCaptureConnection || signaling.operations[1] != captureplane.OperationPullCaptureTracks || signaling.operations[2] != captureplane.OperationRenegotiateCaptureConnection {
		t.Fatalf("operation order = %#v", signaling.operations)
	}
	if len(signaling.keys) == 0 || len(signaling.keys[0]) > captureplane.MaxIdempotencyKeyBytes {
		t.Fatalf("idempotency key is invalid: %#v", signaling.keys)
	}
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("same-revision bootstrap replay: %v", err)
	}
	if len(signaling.operations) != 3 {
		t.Fatalf("same-revision replay issued provider calls: %#v", signaling.operations)
	}
}

func TestCoordinatorBootstrapOfferRemoteAnswer(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: offerNeeded("provider-offer"), renegotiation: []captureplane.Negotiation{{Requirement: captureplane.NegotiationRemoteAnswer, Description: &captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}}}
	peer := &fakePeer{offer: captureplane.Negotiation{ID: "provider-offer", Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if len(peer.createdOfferIDs) != 1 || peer.createdOfferIDs[0] != "provider-offer" {
		t.Fatalf("offer IDs = %#v", peer.createdOfferIDs)
	}
	if len(peer.appliedAnswers) != 1 || peer.appliedAnswers[0].Requirement != captureplane.NegotiationRemoteAnswer {
		t.Fatalf("applied answers = %#v", peer.appliedAnswers)
	}
}

func TestCoordinatorReconcileClosesBeforePullsAndAcceptsEmptyPlan(t *testing.T) {
	attempt := newAttempt(t)
	initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	peer := &fakePeer{}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	replacement := newPlan(t, attempt, 2, []planTrack{{name: "two"}})
	if _, err := coordinator.Reconcile(context.Background(), replacement); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if signaling.operations[len(signaling.operations)-2] != captureplane.OperationCloseCaptureTracks || signaling.operations[len(signaling.operations)-1] != captureplane.OperationPullCaptureTracks {
		t.Fatalf("replacement order = %#v", signaling.operations)
	}
	empty := newPlan(t, attempt, 3, nil)
	got, err := coordinator.Reconcile(context.Background(), empty)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(got.Tracks) != 0 || signaling.operations[len(signaling.operations)-1] != captureplane.OperationCloseCaptureTracks {
		t.Fatalf("removed tracks = %#v, operations = %#v", got.Tracks, signaling.operations)
	}
	if _, err := coordinator.Reconcile(context.Background(), replacement); !errors.Is(err, ErrStalePlan) {
		t.Fatalf("stale plan error = %v", err)
	}
	if got, err := coordinator.Snapshot(); err != nil || got.Connection.PlanRevision != got.PlanRevision {
		t.Fatalf("snapshot connection revision = %d, plan revision = %d, err = %v", got.Connection.PlanRevision, got.PlanRevision, err)
	}
}

func TestCoordinatorClosesExactCaptureEpochOnce(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close replay: %v", err)
	}
	if countOperation(signaling.operations, captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatalf("close operations = %#v", signaling.operations)
	}
	if _, err := coordinator.Snapshot(); !errors.Is(err, ErrCaptureClosed) {
		t.Fatalf("snapshot after close error = %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), plan); !errors.Is(err, ErrCaptureClosed) {
		t.Fatalf("reconcile after close error = %v", err)
	}
}

func TestCoordinatorCloseNegotiationSettlesBeforePull(t *testing.T) {
	cases := []struct {
		name             string
		closeNegotiation captureplane.Negotiation
		wantPeerOffer    bool
	}{
		{name: "answer", closeNegotiation: answerNeeded("close-answer")},
		{name: "offer", closeNegotiation: offerNeeded("close-offer"), wantPeerOffer: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			attempt := newAttempt(t)
			initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
			signaling := &fakeSignaling{closeNegotiation: test.closeNegotiation}
			peer := &fakePeer{answer: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}, offer: captureplane.Negotiation{ID: test.closeNegotiation.ID, Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
			coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 1})
			if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
				t.Fatalf("bootstrap: %v", err)
			}
			if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 2, []planTrack{{name: "two"}})); err != nil {
				t.Fatalf("reconcile: %v", err)
			}
			closeIndex := indexOfOperation(signaling.operations, captureplane.OperationCloseCaptureTracks)
			pullIndex := lastIndexOfOperation(signaling.operations, captureplane.OperationPullCaptureTracks)
			if closeIndex < 0 || pullIndex <= closeIndex+1 || signaling.operations[closeIndex+1] != captureplane.OperationRenegotiateCaptureConnection {
				t.Fatalf("operation order = %#v", signaling.operations)
			}
			if len(signaling.renegotiateIDs) != 1 || signaling.renegotiateIDs[0] != test.closeNegotiation.ID {
				t.Fatalf("close negotiation IDs = %#v", signaling.renegotiateIDs)
			}
			if test.wantPeerOffer && len(peer.createdOfferIDs) != 1 {
				t.Fatalf("created offer IDs = %#v", peer.createdOfferIDs)
			}
		})
	}
}

func TestCoordinatorBoundsNegotiationLoop(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: offerNeeded("provider-0"), repeatOffer: true}
	peer := &fakePeer{offer: captureplane.Negotiation{ID: "provider-0", Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 2})
	if _, err := coordinator.Bootstrap(context.Background(), plan); !errors.Is(err, ErrNegotiationLoop) {
		t.Fatalf("bootstrap error = %v", err)
	}
	if len(signaling.renegotiateIDs) != 2 {
		t.Fatalf("renegotiations = %#v", signaling.renegotiateIDs)
	}
}

func TestCoordinatorRenewLeaseCarriesIntoLaterCommands(t *testing.T) {
	attempt := newAttempt(t)
	initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{Now: func() time.Time { return coordinatorNow }})
	if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	renewed := capturesignaling.WorkerLease{Owner: attempt.Lease.Owner, Token: attempt.Lease.Token, ExpiresAt: coordinatorNow.Add(2 * time.Hour)}
	if err := coordinator.RenewLeaseAt(renewed, coordinatorNow); err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 2, []planTrack{{name: "two"}})); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(signaling.leases) == 0 || !signaling.leases[len(signaling.leases)-1].Equal(renewed.ExpiresAt) {
		t.Fatalf("last lease expiry = %v, want %v", signaling.leases, renewed.ExpiresAt)
	}
	if err := coordinator.RenewLeaseAt(renewed, coordinatorNow); err != nil {
		t.Fatalf("idempotent renewal: %v", err)
	}
}

func TestCoordinatorRejectsExpiredDeadlineAndWrongExecutionKey(t *testing.T) {
	attempt := newAttempt(t)
	attempt.HardDeadline = coordinatorNow
	if _, err := NewCoordinator(attempt, &fakeSignaling{}, &fakePeer{}, Config{Now: func() time.Time { return coordinatorNow }}); !errors.Is(err, ErrDeadlineExpired) {
		t.Fatalf("expired deadline error = %v", err)
	}

	attempt = newAttempt(t)
	coordinator := newCoordinator(t, attempt, &fakeSignaling{wrongKey: true}, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, attempt, 1, nil)); !errors.Is(err, ErrProtocol) {
		t.Fatalf("wrong execution key error = %v", err)
	}
}

type fakePeer struct {
	registered      []captureplane.PulledCaptureTrack
	answer          captureplane.Description
	offer           captureplane.Negotiation
	createdOfferIDs []captureplane.ProviderReference
	appliedAnswers  []captureplane.Negotiation
}

func (p *fakePeer) RegisterTracks(tracks []captureplane.PulledCaptureTrack) error {
	p.registered = append(p.registered, tracks...)
	return nil
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
