package recordingdecode

import (
	"context"
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func ingestBundles(ctx context.Context, request Request, catalog map[sourceIdentity]recordingpresentation.MediaSource, spoolDirectory string) (map[string]*sourceState, []observedGap, error) {
	bundles := append([]BundleFile(nil), request.Bundles...)
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].Sequence < bundles[j].Sequence })
	dataKeys := make(map[int64][]byte, len(request.DataKeys))
	for _, key := range request.DataKeys {
		dataKeys[key.CaptureEpoch] = key.Plaintext
	}
	states := make(map[string]*sourceState)
	gaps := make([]observedGap, 0)
	var previous *recordingbundle.Bundle
	var previousDigest string
	var recoveryGeneration uint64
	var inputBytes int64
	for index, file := range bundles {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		key, keyExists := dataKeys[file.CaptureEpoch]
		if (index > 0 && file.Sequence <= bundles[index-1].Sequence) || file.CaptureEpoch <= 0 || file.CaptureEpoch > request.CaptureEpoch ||
			strings.TrimSpace(file.CaptureJobID) == "" || !isLowerSHA256(file.RecorderEnvelopeDigest) || !isLowerSHA256(file.ExpectedSHA256) || !keyExists {
			return nil, nil, fmt.Errorf("%w: invalid bundle file authority", ErrInvalidRequest)
		}
		encoded, err := readRegularFile(file.Path, &inputBytes)
		if err != nil {
			return nil, nil, err
		}
		if recordingbundle.ObjectChecksumHex(encoded) != file.ExpectedSHA256 {
			clear(encoded)
			return nil, nil, fmt.Errorf("%w: encrypted object checksum mismatch", ErrInvalidBundle)
		}
		bundle, err := recordingbundle.Decrypt(key, encoded)
		clear(encoded)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: decrypt sequence %d: %v", ErrInvalidBundle, file.Sequence, err)
		}
		if err := validateBundleAuthority(request, file, bundle); err != nil {
			clearBundle(&bundle)
			return nil, nil, err
		}
		if previous != nil {
			if err := recordingbundle.ValidateSequence(*previous, bundle); err != nil {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: sequence %d: %v", ErrInvalidBundle, file.Sequence, err)
			}
			if bundle.Manifest.CaptureEpoch < previous.Manifest.CaptureEpoch {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: capture epoch regressed", ErrInvalidBundle)
			}
			if bundle.Manifest.CaptureEpoch > previous.Manifest.CaptureEpoch ||
				(previousDigest != "" && previousDigest != bundle.Manifest.RecorderEnvelopeDigest) {
				recoveryGeneration++
				gaps = append(gaps, observedGap{startMS: previous.Manifest.MediaRange.EndMilliseconds, endMS: bundle.Manifest.MediaRange.StartMilliseconds, reason: "attempt_recovery"})
			}
		}
		for _, gap := range bundle.Gaps {
			gaps = append(gaps, observedGap{startMS: gap.StartMediaMilliseconds, endMS: gap.EndMediaMilliseconds, reason: discontinuityReason(gap.Reason, gap.ReplacementAttempt > 0)})
		}
		for _, fragment := range bundle.Fragments {
			// Audio preparation does not depend on video presentation events.
			// Bundle integrity and capture authority have already been checked.
			if !request.includesSource(recordingpresentation.MediaKindCamera) && !request.includesSource(recordingpresentation.MediaKindScreenShare) {
				codec := strings.ToLower(strings.TrimSpace(fragment.Track.Codec))
				if codec == "vp8" || codec == "h264" {
					continue
				}
			}
			source, exists := catalog[sourceIdentity{trackID: fragment.Track.TrackID, epoch: fragment.Track.Epoch}]
			if !exists {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: track %q epoch %d is absent from presentation", ErrInvalidBundle, fragment.Track.TrackID, fragment.Track.Epoch)
			}
			if err := validateTrackKind(source.Kind, fragment.Track.Codec); err != nil {
				clearBundle(&bundle)
				return nil, nil, err
			}
			if !request.includesSource(source.Kind) {
				continue
			}
			state := states[source.SourceID]
			if state == nil {
				state = &sourceState{presentation: source, track: fragment.Track, spoolPath: filepath.Join(spoolDirectory, source.SourceID+".rtp")}
				states[source.SourceID] = state
			} else if state.track != fragment.Track {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: source track identity mutated", ErrInvalidBundle)
			}
			if err := appendFragmentRun(ctx, state, fragment, recoveryGeneration); err != nil {
				clearBundle(&bundle)
				return nil, nil, err
			}
		}
		previousCopy := bundle
		previous = &previousCopy
		previousDigest = bundle.Manifest.RecorderEnvelopeDigest
		clearBundle(&bundle)
	}
	stateIDs := make([]string, 0, len(states))
	for sourceID := range states {
		stateIDs = append(stateIDs, sourceID)
	}
	sort.Strings(stateIDs)
	for _, sourceID := range stateIDs {
		if err := finalizeSourceSpool(ctx, states[sourceID]); err != nil {
			return nil, nil, err
		}
	}
	return states, gaps, nil
}

func validateBundleAuthority(request Request, file BundleFile, bundle recordingbundle.Bundle) error {
	manifest := bundle.Manifest
	context := manifest.Encryption
	if manifest.Sequence != file.Sequence || manifest.RecordingID != request.RecordingID || manifest.CaptureEpoch != uint64(file.CaptureEpoch) ||
		manifest.RecorderEnvelopeDigest != file.RecorderEnvelopeDigest || manifest.MediaRange.EndMilliseconds > request.DurationMS ||
		context.Environment != request.Environment || context.TenantID != request.TenantID ||
		context.EpisodeID != request.EpisodeID || context.RecordingID != request.RecordingID ||
		context.JobID != file.CaptureJobID || context.BundleSchema != file.BundleSchema || bundle.Version != file.BundleSchema ||
		(file.BundleSchema == recordingbundle.Version && manifest.Encryption.KeyHandle != file.KeyHandle) {
		return fmt.Errorf("%w: sequence %d authority mismatch", ErrInvalidBundle, file.Sequence)
	}
	return nil
}

func validateTrackKind(kind recordingpresentation.MediaKind, codec string) error {
	codec = strings.ToLower(strings.TrimSpace(codec))
	if kind == recordingpresentation.MediaKindMicrophone && codec == "opus" {
		return nil
	}
	if (kind == recordingpresentation.MediaKindCamera || kind == recordingpresentation.MediaKindScreenShare) && (codec == "vp8" || codec == "h264") {
		return nil
	}
	return fmt.Errorf("%w: presentation kind %q cannot decode codec %q", ErrInvalidBundle, kind, codec)
}

func clearBundle(bundle *recordingbundle.Bundle) {
	if bundle == nil {
		return
	}
	for fragmentIndex := range bundle.Fragments {
		for packetIndex := range bundle.Fragments[fragmentIndex].Packets {
			clear(bundle.Fragments[fragmentIndex].Packets[packetIndex].Payload)
		}
	}
	bundle.Fragments = nil
}

func isLowerSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}
