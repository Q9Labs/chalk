package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"maps"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestCaptureBindWatcherKeepsFirstPlanEpochForLateTrack(t *testing.T) {
	origin := time.Unix(4_000, 0).UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	binding := capturePlanWatchPulledTrack(t, "0", "late-publisher")
	track := &captureTestTrack{capture: binding, codec: "opus"}
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	first := capturePlanWatchPlan(t, authority, 1, origin, captureplan.StopStateRunning, binding)
	second := capturePlanWatchPlan(t, authority, 2, origin.Add(time.Second), captureplan.StopStateRunning, binding)
	planEvents := make(chan capturePlanEvent, 1)
	binds := 0
	peer := &capturePlanWatchPeer{wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		if mid != binding.MID {
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
		binds++
		if binds == 1 {
			planEvents <- capturePlanEvent{plan: second}
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return track, nil
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		2: {PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{binding}},
	})
	writer.attempt.peer = peer
	writer.attempt.coordinator = coordinator
	writer.attempt.config.InitialPlanWait = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	bound, plan, stopped, err := writer.attempt.bindTracksWhileWatchingPlans(ctx, writer, first,
		recordercapture.Snapshot{PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{binding}}, planEvents, nil, nil)
	if err != nil || stopped || plan.Revision() != 2 || binds != 2 {
		t.Fatalf("bind result: revision=%d stopped=%v binds=%d error=%v", plan.Revision(), stopped, binds, err)
	}
	if err := writer.reconcileTracks(ctx, plan, bound, origin.Add(time.Second)); err != nil {
		t.Fatalf("reconcile bound track: %v", err)
	}
	want, err := recordingbundle.ComposeTrackEpoch(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := writer.active[binding.MID.String()].Epoch; got != want {
		t.Fatalf("late-bound track epoch = %d, want first observed revision epoch %d", got, want)
	}
}

func TestCaptureBundleEpochsMatchPresentationAcrossPlanChanges(t *testing.T) {
	origin := time.Unix(5_000, 0).UTC()
	authority := captureTestPlanAtEpoch(t, 2, 1, origin).Authority()
	first := capturePlanWatchPulledTrack(t, "0", "original")
	guest := capturePlanWatchPulledTrack(t, "1", "guest")
	guest.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	rebound := capturePlanWatchPulledTrack(t, "2", "rebound")
	plans := []captureplan.Plan{
		captureEpochParityPlan(t, authority, 1, origin, false, first),
		captureEpochParityPlan(t, authority, 2, origin, true, first, guest),
		captureEpochParityPlan(t, authority, 3, origin, true, first, guest),
		captureEpochParityPlan(t, authority, 4, origin, true, rebound, guest),
		captureEpochParityPlan(t, authority, 5, origin, true, guest),
		captureEpochParityPlan(t, authority, 6, origin, true, rebound, guest),
	}
	profile, err := recordingpresentation.NewComposite720PProfile()
	if err != nil {
		t.Fatal(err)
	}
	source := recordingpresentation.CompletionSource{
		PresentationHandle: authority.RecordingID, TenantID: authority.TenantID, SpaceID: authority.SpaceID,
		EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, CaptureEpoch: 2,
		CaptureReadyAt: origin, DurationMillis: 10_000, Profile: profile, SpaceName: "Recorded space",
		EpisodeControlStartRevision: 1, EpisodeControlOriginRevision: 1, CapturePlanStartRevision: 1,
		BaselineControlState: []byte(fmt.Sprintf(
			`{"control_revision":1,"participants":[{"participant_id":%q,"display_name":"Participant","hand_raised":false,"admission_revision":1}]}`,
			first.ParticipantID.String())),
		EpisodeControlTailEvents: []recordingpresentation.ControlEventFact{{
			Revision: 2, Name: "participant_joined", CreatedAt: origin.Add(500 * time.Millisecond),
			Payload: []byte(fmt.Sprintf(`{"participant_id":%q,"display_name":"Participant","admission_revision":2}`, guest.ParticipantID.String())),
		}},
	}
	for index, plan := range plans {
		source.CapturePlans = append(source.CapturePlans, recordingpresentation.CapturePlanFact{
			Revision: int64(index + 1), Plan: plan, CreatedAt: origin.Add(time.Duration(index) * time.Second),
		})
	}
	objects := &captureEpochParityObjects{items: make(map[string]captureEpochParityObject)}
	freezer, err := recordingpresentation.NewFreezer(captureEpochParitySource{source}, objects)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := freezer.Prepare(context.Background(), recordingpresentation.CompletionAuthority{
		JobID: authority.JobID, AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 2,
		EnvelopeDigest: bytesOf(0x42), LeaseToken: "lease", LeaseOwner: "worker",
	})
	if err != nil {
		t.Fatalf("build recording presentation: %v", err)
	}
	timeline, err := recordingpresentation.Decode(objects.items[prepared.PresentationObject.Key].body)
	if err != nil {
		t.Fatalf("decode recording presentation: %v", err)
	}
	presentationEpochs := make(map[string]int64)
	for _, media := range timeline.Initial.Media {
		presentationEpochs[media.SourceID] = media.Epoch
	}
	for _, event := range timeline.Events {
		if changed, ok := event.(*recordingpresentation.MediaSourceChangedEvent); ok {
			presentationEpochs[changed.Source.SourceID] = changed.Source.Epoch
		}
	}

	writer, _ := newCaptureTestWriter(t, origin)
	firstTrack := &captureTestTrack{capture: first, codec: "opus"}
	guestTrack := &captureTestTrack{capture: guest, codec: "opus"}
	reboundTrack := &captureTestTrack{capture: rebound, codec: "opus"}
	boundByRevision := []map[string]CaptureMediaTrack{
		nil, nil,
		{"0": firstTrack, "1": guestTrack},
		{"2": reboundTrack, "1": guestTrack},
		{"1": guestTrack},
		{"2": reboundTrack, "1": guestTrack},
	}
	writerEpochs := make(map[string]int64)
	for index, plan := range plans {
		if err := writer.reconcileTracks(context.Background(), plan, boundByRevision[index], origin.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatalf("reconcile revision %d: %v", index+1, err)
		}
		for mid, identity := range writer.active {
			binding := writer.bindings[mid]
			sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{
				RecordingID: source.RecordingID.String(), ParticipantID: binding.ParticipantID.String(),
				ParticipantGeneration: binding.ParticipantGeneration, Kind: recordingpresentation.MediaKindMicrophone,
				TrackID: identity.TrackID, Epoch: int64(identity.Epoch),
			})
			if err != nil {
				t.Fatalf("derive writer source identity: %v", err)
			}
			writerEpochs[sourceID] = int64(identity.Epoch)
		}
	}
	if len(presentationEpochs) != 4 || !maps.Equal(writerEpochs, presentationEpochs) {
		t.Fatalf("writer source epochs = %v, presentation source epochs = %v", writerEpochs, presentationEpochs)
	}
}

func captureEpochParityPlan(t *testing.T, authority captureplan.PlanAuthority, revision captureplane.PlanRevision, origin time.Time, joinedGuest bool, tracks ...captureplane.PulledCaptureTrack) captureplan.Plan {
	t.Helper()
	participants := []captureplan.ParticipantSnapshot{{
		ID: captureTestID(t, "88888888-8888-4888-8888-888888888888"), Generation: 1, DisplayName: "Participant", JoinOrdinal: 1, Lifecycle: captureplan.ParticipantActive,
	}}
	controlRevision := int64(1)
	if joinedGuest {
		controlRevision = 2
		participants = append(participants, captureplan.ParticipantSnapshot{
			ID: captureTestID(t, "99999999-9999-4999-8999-999999999999"), Generation: 1, DisplayName: "Participant", JoinOrdinal: 2, Lifecycle: captureplan.ParticipantActive,
		})
	}
	snapshots := make([]captureplan.TrackSnapshot, 0, len(tracks))
	for _, track := range tracks {
		snapshots = append(snapshots, captureplan.TrackSnapshot{
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, OwnerReference: track.OwnerReference,
			TrackReference: track.TrackReference, OwnerMID: "owner-mid-" + track.MID,
			PublicationReference: captureplan.PublicationReference("publication-" + track.MID), RequestedLayer: track.RequestedLayer,
		})
	}
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: authority, Revision: revision,
		Cursors:       captureplan.PlanCursors{EpisodeControlRevision: controlRevision, ProviderIncarnation: 1, ProviderSequence: int64(revision)},
		LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 1_000_000,
		EffectiveDeadline: origin.Add(time.Hour), StopState: captureplan.StopStateRunning,
		Participants: participants, Tracks: snapshots,
	})
	if err != nil {
		t.Fatalf("create parity plan revision %d: %v", revision, err)
	}
	return plan
}

type captureEpochParitySource struct {
	source recordingpresentation.CompletionSource
}

func (reader captureEpochParitySource) LoadCompletionSource(context.Context, recordingpresentation.CompletionAuthority) (recordingpresentation.CompletionSource, error) {
	return reader.source, nil
}

type captureEpochParityObject struct {
	object objectstorage.Object
	body   []byte
}

type captureEpochParityObjects struct {
	items map[string]captureEpochParityObject
}

func (store *captureEpochParityObjects) PutObject(_ context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	if _, exists := store.items[input.Key]; exists {
		return objectstorage.Object{}, objectstorage.ErrObjectAlreadyExists
	}
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return objectstorage.Object{}, err
	}
	if int64(len(body)) != input.ContentLength {
		return objectstorage.Object{}, fmt.Errorf("presentation test object length mismatch")
	}
	digest := sha256.Sum256(body)
	object := objectstorage.Object{Key: input.Key, ContentType: input.ContentType, Size: int64(len(body)), ETag: fmt.Sprintf(`"%x"`, digest[:8])}
	store.items[input.Key] = captureEpochParityObject{object: object, body: body}
	return object, nil
}

func (store *captureEpochParityObjects) GetObject(_ context.Context, key string) (objectstorage.ObjectReader, error) {
	item, exists := store.items[key]
	if !exists {
		return objectstorage.ObjectReader{}, objectstorage.ErrObjectNotFound
	}
	return objectstorage.ObjectReader{Object: item.object, Body: io.NopCloser(bytes.NewReader(item.body))}, nil
}
