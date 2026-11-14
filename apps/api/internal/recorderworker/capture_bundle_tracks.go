package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (w *captureBundleWriter) ensureAssembler(ctx context.Context) error {
	if w.assembler != nil {
		return nil
	}
	lease := w.attempt.currentLease()
	if w.key == nil {
		dataKey, err := w.attempt.keys.AccessKey(ctx, CaptureKeyRequest{
			TenantID: w.attempt.authority.TenantID.String(), SpaceID: w.attempt.authority.SpaceID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(),
			KeyHandle: w.attempt.authority.Envelope.KeyHandle, CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Attempt: w.attempt.authority.AttemptCount, FencingGeneration: w.attempt.authority.FencingGeneration,
			LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt, EnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		})
		if err != nil {
			return fmt.Errorf("access recording key: %w", err)
		}
		if len(dataKey.Plaintext) != 32 || len(dataKey.EncryptionContextDigest) != sha256.Size {
			clear(dataKey.Plaintext)
			return fmt.Errorf("%w: recording key response is invalid", ErrInvalidCaptureAttempt)
		}
		w.key = dataKey.Plaintext
		w.contextDigest = append([]byte(nil), dataKey.EncryptionContextDigest...)
	}
	reservationRequestID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("generate recording bundle reservation request ID: %w", err)
	}
	request := BundleReserveRequest{
		TenantID: w.attempt.authority.TenantID.String(), SpaceID: w.attempt.authority.SpaceID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(),
		ObjectHandle: w.attempt.authority.Envelope.ObjectHandle,
		CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Attempt: w.attempt.authority.AttemptCount, FencingGeneration: w.attempt.authority.FencingGeneration,
		LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt, EnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		ReservationRequestID: reservationRequestID.String(), EncryptionContextDigest: append([]byte(nil), w.contextDigest...),
	}
	reservation, err := w.attempt.bundles.Reserve(ctx, request)
	if err != nil {
		return fmt.Errorf("reserve recording bundle: %w", err)
	}
	if reservation.AllocationVersion <= 0 || strings.TrimSpace(reservation.ObjectKey) == "" {
		return fmt.Errorf("%w: invalid bundle reservation", ErrInvalidCaptureAttempt)
	}
	w.reservation = reservation
	w.reserveOrdinal++
	encryption := recordingbundle.EncryptionContext{Environment: w.attempt.config.Environment, TenantID: w.attempt.authority.TenantID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(), BundleSchema: w.attempt.authority.Envelope.BundleSchemaVersion}
	if encryption.BundleSchema == recordingbundle.Version {
		encryption.KeyHandle = w.attempt.authority.Envelope.KeyHandle
	}
	assembler, err := recordingbundle.NewAssembler(recordingbundle.AssemblerConfig{RecordingID: w.attempt.authority.RecordingID.String(), CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Sequence: reservation.Sequence, RecorderEnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest), Encryption: encryption, AllocationVersion: reservation.AllocationVersion})
	if err != nil {
		return err
	}
	w.assembler = assembler
	if len(w.pendingGaps) > 0 {
		for _, gap := range w.pendingGaps {
			if err := w.assembler.AddGap(gap); err != nil {
				return err
			}
		}
		w.pendingGaps = nil
	}
	keys := make([]string, 0, len(w.active))
	for key := range w.active {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		identity := w.active[key]
		if err := w.assembler.AddTrackEvent(recordingbundle.TrackTimelineEvent{Kind: recordingbundle.TrackEventAdded, Track: identity, MonotonicMilliseconds: w.lastMono, MediaMilliseconds: w.lastMedia, Reason: "bundle_start"}); err != nil {
			return err
		}
	}
	if w.hasLayout {
		snapshot := w.layout
		snapshot.Kind = recordingbundle.LayoutEventSnapshot
		snapshot.MonotonicMilliseconds = w.lastMono
		snapshot.MediaMilliseconds = w.lastMedia
		if err := w.assembler.AddLayoutEvent(snapshot); err != nil {
			return err
		}
	}
	return nil
}

func (w *captureBundleWriter) addPacket(ctx context.Context, track CaptureMediaTrack, packet *rtp.Packet, at time.Time) error {
	identity := track.CaptureTrack()
	mid := string(identity.MID)
	activeBinding, active := w.bindings[mid]
	if !active || activeBinding != identity {
		// A reader cancellation may leave already-queued packets behind. They
		// belong to the prior binding and must not be relabeled as replacement
		// media that reused the same MID.
		return nil
	}
	bundleTrack := w.active[mid]
	clockKey := trackClockKey(bundleTrack)
	clock := w.clocks[clockKey]
	if clock == nil {
		clock = &captureTrackClock{}
		w.clocks[clockKey] = clock
	}
	arrivalMono := w.relative(at)
	trackMedia, normalizedTimestamp := clock.normalize(packet, identity.Kind, arrivalMono)
	mono := max(arrivalMono, w.lastMono)
	// Bundle ranges share one non-regressing recording clock. Per-track sender
	// timing remains independently preserved in the normalized RTP timestamp.
	media := max(trackMedia, w.lastMedia)
	w.advanceClocks(mono, media)
	input := recordingbundle.MediaPacket{Track: bundleTrack, Packet: recordingbundle.RTPPacket{SequenceNumber: packet.SequenceNumber, ExtendedSequenceNumber: clock.sequence.Extend(packet.SequenceNumber), Timestamp: normalizedTimestamp, SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker, Payload: packet.Payload}, MonotonicMilliseconds: mono, MediaMilliseconds: media}
	var err error
	for attempt := range 2 {
		if err = w.ensureAssembler(ctx); err != nil {
			return err
		}
		err = w.assembler.AddPacket(input)
		if err == nil {
			if w.assembler.Closed() {
				return w.persist(ctx)
			}
			return nil
		}
		if !errors.Is(err, recordingbundle.ErrAssemblerClosed) && !errors.Is(err, recordingbundle.ErrDurationLimit) {
			return err
		}
		// A packet with persistent cross-track clock skew may not fit even
		// after rotation. Do not recursively allocate and upload empty bundles.
		if attempt == 1 {
			break
		}
		if persistErr := w.persist(ctx); persistErr != nil {
			return persistErr
		}
	}
	return fmt.Errorf("packet could not fit after bundle rotation: %w", err)
}

// observePlan retains the first revision of each unchanged publication, even
// when a newer plan arrives before its RTP track finishes binding.
func (w *captureBundleWriter) observePlan(plan captureplan.Plan) error {
	epoch, err := recordingbundle.ComposeTrackEpoch(uint64(plan.Authority().CaptureEpoch), uint64(plan.Revision()))
	if err != nil {
		return fmt.Errorf("%w: compose track epoch: %v", ErrInvalidCaptureAttempt, err)
	}
	next := make(map[string]plannedTrackEpoch, len(plan.Tracks()))
	for _, track := range plan.Tracks() {
		key := track.ParticipantID.String() + "\x00" + string(track.Source)
		binding := captureplane.CaptureTrack{
			OwnerReference: track.OwnerReference, TrackReference: track.TrackReference,
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, RequestedLayer: track.RequestedLayer,
		}
		first := plannedTrackEpoch{binding: binding, epoch: epoch}
		if prior, exists := w.plannedEpochs[key]; exists && prior.binding == binding {
			first = prior
		}
		next[key] = first
	}
	w.plannedEpochs = next
	return nil
}

func (w *captureBundleWriter) reconcileTracks(ctx context.Context, plan captureplan.Plan, tracks map[string]CaptureMediaTrack, now time.Time) error {
	if plan.Authority().CaptureEpoch != w.attempt.authority.CaptureEpoch {
		return fmt.Errorf("%w: capture plan epoch mismatch", ErrInvalidCaptureAttempt)
	}
	if err := w.observePlan(plan); err != nil {
		return err
	}
	previousActive := w.active
	next := make(map[string]recordingbundle.TrackIdentity, len(tracks))
	nextBindings := make(map[string]captureplane.PulledCaptureTrack, len(tracks))
	planEpoch, err := recordingbundle.ComposeTrackEpoch(uint64(plan.Authority().CaptureEpoch), uint64(plan.Revision()))
	if err != nil {
		return fmt.Errorf("%w: compose track epoch: %v", ErrInvalidCaptureAttempt, err)
	}
	for mid, mediaTrack := range tracks {
		track := mediaTrack.CaptureTrack()
		epoch := planEpoch
		key := track.ParticipantID.String() + "\x00" + string(track.Source)
		if first, ok := w.plannedEpochs[key]; ok && first.binding == track.CaptureTrack {
			epoch = first.epoch
		}
		if existingBinding, ok := w.bindings[mid]; ok && existingBinding == track {
			if existing, active := w.active[mid]; active && existing.Codec == mediaTrack.Codec() {
				epoch = existing.Epoch
			}
		}
		next[mid] = recordingbundle.TrackIdentity{TrackID: track.TrackReference.String(), Epoch: epoch, MID: track.MID.String(), Codec: mediaTrack.Codec(), Layer: track.RequestedLayer.String()}
		nextBindings[mid] = track
	}
	changed := len(next) != len(w.active)
	if !changed {
		for key, value := range next {
			if w.active[key] != value {
				changed = true
				break
			}
		}
	}
	if changed && w.assembler != nil {
		eventMono, eventMedia := w.controlEventClocks(now)
		keys := make([]string, 0, len(w.active))
		for key := range w.active {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			previous, exists := w.active[key]
			current, stillActive := next[key]
			if !exists || (stillActive && previous == current) {
				continue
			}
			kind := recordingbundle.TrackEventRemoved
			if stillActive {
				kind = recordingbundle.TrackEventReplaced
			}
			event := recordingbundle.TrackTimelineEvent{Kind: kind, Track: previous, MonotonicMilliseconds: eventMono, MediaMilliseconds: eventMedia, Reason: "plan_track_set_change"}
			if err := w.appendControlEvent(ctx, eventMono, eventMedia, func(assembler *recordingbundle.Assembler) error {
				return assembler.AddTrackEvent(event)
			}); err != nil {
				return err
			}
			if w.assembler == nil {
				break
			}
		}
		if w.assembler != nil {
			if err := w.assembler.Close(recordingbundle.CloseReasonTrackSetChange, w.lastMono, w.lastMedia); err != nil && !errors.Is(err, recordingbundle.ErrEmptyBundle) {
				return err
			}
			if w.assembler.Closed() {
				if err := w.persist(ctx); err != nil {
					return err
				}
			}
		}
	}
	w.active = next
	w.bindings = nextBindings
	if changed && w.assembler != nil {
		eventMono, eventMedia := w.controlEventClocks(now)
		keys := make([]string, 0, len(w.active))
		for key := range w.active {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if _, existed := previousActive[key]; existed {
				continue
			}
			event := recordingbundle.TrackTimelineEvent{Kind: recordingbundle.TrackEventAdded, Track: w.active[key], MonotonicMilliseconds: eventMono, MediaMilliseconds: eventMedia, Reason: "plan_track_added"}
			if err := w.appendControlEvent(ctx, eventMono, eventMedia, func(assembler *recordingbundle.Assembler) error {
				return assembler.AddTrackEvent(event)
			}); err != nil {
				return err
			}
			if w.assembler == nil {
				break
			}
		}
	}
	if changed {
		if err := w.setLayout(ctx, plan, now); err != nil {
			return err
		}
	}
	return nil
}

func trackClockKey(track recordingbundle.TrackIdentity) string {
	return fmt.Sprintf("%s\x00%d\x00%s", track.TrackID, track.Epoch, track.MID)
}
