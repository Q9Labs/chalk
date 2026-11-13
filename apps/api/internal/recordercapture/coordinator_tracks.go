package recordercapture

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func tracksForPlan(plan captureplan.Plan) ([]captureplane.CaptureTrack, error) {
	tracks := make([]captureplane.CaptureTrack, 0, len(plan.Tracks()))
	for _, track := range plan.Tracks() {
		tracks = append(tracks, captureplane.CaptureTrack{
			OwnerReference: track.OwnerReference, TrackReference: track.TrackReference,
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, RequestedLayer: track.RequestedLayer,
		})
	}
	if len(tracks) == 0 {
		return nil, nil
	}
	canonical, err := captureplane.CanonicalizeCaptureTracks(tracks)
	if err != nil {
		return nil, fmt.Errorf("%w: tracks: %w", ErrInvalidPlan, err)
	}
	return canonical, nil
}

func tracksWithout(active map[string]captureplane.PulledCaptureTrack, removed []captureplane.PulledCaptureTrack) []captureplane.PulledCaptureTrack {
	removedKeys := make(map[string]struct{}, len(removed))
	for _, track := range removed {
		removedKeys[trackKey(track.CaptureTrack)] = struct{}{}
	}
	remaining := make([]captureplane.PulledCaptureTrack, 0, len(active)-len(removedKeys))
	for key, track := range active {
		if _, remove := removedKeys[key]; !remove {
			remaining = append(remaining, track)
		}
	}
	sort.Slice(remaining, func(i, j int) bool { return remaining[i].MID < remaining[j].MID })
	return remaining
}

func diffTracks(active map[string]captureplane.PulledCaptureTrack, desired []captureplane.CaptureTrack) ([]captureplane.PulledCaptureTrack, []captureplane.CaptureTrack) {
	desiredByKey := make(map[string]captureplane.CaptureTrack, len(desired))
	for _, track := range desired {
		desiredByKey[trackKey(track)] = track
	}
	removed := make([]captureplane.PulledCaptureTrack, 0)
	for key, current := range active {
		desiredTrack, ok := desiredByKey[key]
		if !ok || !sameTrack(current.CaptureTrack, desiredTrack) {
			removed = append(removed, current)
		}
	}
	additions := make([]captureplane.CaptureTrack, 0)
	for key, desiredTrack := range desiredByKey {
		current, ok := active[key]
		if !ok || !sameTrack(current.CaptureTrack, desiredTrack) {
			additions = append(additions, desiredTrack)
		}
	}
	sort.Slice(removed, func(i, j int) bool { return trackKey(removed[i].CaptureTrack) < trackKey(removed[j].CaptureTrack) })
	sort.Slice(additions, func(i, j int) bool { return trackKey(additions[i]) < trackKey(additions[j]) })
	return removed, additions
}

func sameTrack(left captureplane.CaptureTrack, right captureplane.CaptureTrack) bool {
	return left.OwnerReference == right.OwnerReference && left.TrackReference == right.TrackReference && left.ParticipantID == right.ParticipantID && left.ParticipantGeneration == right.ParticipantGeneration && left.Source == right.Source && left.Kind == right.Kind && left.RequestedLayer == right.RequestedLayer
}

func trackKey(track captureplane.CaptureTrack) string {
	return fmt.Sprintf("%s\x00%d\x00%s\x00%s", track.ParticipantID, track.ParticipantGeneration, track.Source, track.Kind)
}

func providerKey(owner, track captureplane.ProviderReference) string {
	return owner.String() + "\x00" + track.String()
}

func stableIdempotencyKey(epoch captureplane.CaptureEpoch, revision captureplane.PlanRevision, operation captureplane.OperationKind, discriminator string) string {
	digest := sha256.Sum256([]byte(discriminator))
	key := fmt.Sprintf("capture/%d/%d/%s/%s", epoch, revision, operation, hex.EncodeToString(digest[:8]))
	if len(key) > captureplane.MaxIdempotencyKeyBytes {
		return key[:captureplane.MaxIdempotencyKeyBytes]
	}
	return key
}

func stringFingerprint(plan captureplan.Plan) string { return plan.FingerprintHex() }

func staleOrConflict(active, next captureplan.Plan) error {
	if active.Revision() > next.Revision() {
		return ErrStalePlan
	}
	if active.Revision() == next.Revision() && stringFingerprint(active) != stringFingerprint(next) {
		return ErrPlanConflict
	}
	return errors.New("capture plan did not advance")
}
