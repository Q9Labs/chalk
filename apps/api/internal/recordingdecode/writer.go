package recordingdecode

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

const spoolRecordHeaderBytes = 22

type sourceIdentity struct {
	trackID string
	epoch   uint64
}

type sourceState struct {
	observedGaps []observedGap
	visibleSpans []visibleSpan
	spanStartMS  int64
	spanEndMS    int64
	hasSpan      bool
	degradation  recordingpipeline.VideoDegradation
	presentation recordingpresentation.MediaSource
	track        recordingbundle.TrackIdentity
	spoolPath    string
	spoolGroups  []spoolRunGroup
}

type observedGap struct {
	startMS int64
	endMS   int64
	reason  string
}

// Write verifies and decrypts stored bundle objects, decodes their RTP
// into browser-seekable per-source media, and atomically publishes one
// decoded_media.v1 directory. It never infers source identity from an object
// path: every included track must join the authenticated presentation timeline
// by the exact (track_id, track_epoch) pair.
func Write(ctx context.Context, request Request) (result Result, resultErr error) {
	if err := validateRequest(ctx, request); err != nil {
		return Result{}, err
	}
	outputDirectory, err := filepath.Abs(request.OutputDirectory)
	if err != nil {
		return Result{}, fmt.Errorf("%w: output directory: %v", ErrInvalidRequest, err)
	}
	if _, err := os.Lstat(outputDirectory); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return Result{}, fmt.Errorf("%w: output directory already exists", ErrInvalidRequest)
		}
		return Result{}, fmt.Errorf("%w: inspect output directory: %v", ErrInvalidRequest, err)
	}
	parent := filepath.Dir(outputDirectory)
	parentInfo, err := os.Stat(parent)
	if err != nil || !parentInfo.IsDir() {
		return Result{}, fmt.Errorf("%w: output parent is unavailable", ErrInvalidRequest)
	}
	temporaryDirectory, err := os.MkdirTemp(parent, "."+filepath.Base(outputDirectory)+".tmp-")
	if err != nil {
		return Result{}, fmt.Errorf("create decoded media workspace: %w", err)
	}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, removeAllWithContext(temporaryDirectory, "remove decoded media workspace"))
		}
	}()
	if err := os.Chmod(temporaryDirectory, 0o700); err != nil {
		return Result{}, fmt.Errorf("secure decoded media workspace: %w", err)
	}

	catalog, err := presentationCatalog(request.Presentation)
	if err != nil {
		return Result{}, err
	}
	spoolDirectory := filepath.Join(temporaryDirectory, ".rtp-spool")
	if err := os.Mkdir(spoolDirectory, 0o700); err != nil {
		return Result{}, fmt.Errorf("create RTP spool: %w", err)
	}
	states, gaps, err := ingestBundles(ctx, request, catalog, spoolDirectory)
	if err != nil {
		return Result{}, err
	}

	mediaDirectory := filepath.Join(temporaryDirectory, "media")
	if err := os.Mkdir(mediaDirectory, 0o700); err != nil {
		return Result{}, fmt.Errorf("create decoded media directory: %w", err)
	}
	runner := request.Runner
	if runner == nil {
		runner = execCommandRunner{}
	}
	ffmpegPath := request.FFmpegPath
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}

	stateValues := make([]*sourceState, 0, len(states))
	for _, state := range states {
		stateValues = append(stateValues, state)
	}
	sort.Slice(stateValues, func(i, j int) bool {
		return stateValues[i].presentation.SourceID < stateValues[j].presentation.SourceID
	})
	sources := make([]Source, 0, len(stateValues))
	degradation := make([]recordingpipeline.VideoDegradation, 0)
	discontinuities := make([]Discontinuity, 0)
	for _, state := range stateValues {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		state.spanStartMS, state.spanEndMS = visualSourceSpan(request.Presentation, state.presentation.SourceID)
		state.visibleSpans = visualSourceSpans(request.Presentation, state.presentation.SourceID)
		state.observedGaps = gaps
		state.hasSpan = true
		source, sourceDiscontinuities, err := decodeSource(ctx, runner, ffmpegPath, temporaryDirectory, mediaDirectory, state, request.DurationMS, request.VideoPassthrough)
		if err != nil {
			return Result{}, err
		}
		if source.SourceID != "" {
			sources = append(sources, source)
		}
		if state.degradation.SourceID != "" {
			degradation = append(degradation, state.degradation)
		}
		discontinuities = append(discontinuities, sourceDiscontinuities...)
	}
	knownQuality := make(map[string]struct{}, len(degradation))
	for _, source := range degradation {
		knownQuality[source.SourceID] = struct{}{}
	}
	for _, source := range catalog {
		if !request.includesSource(source.Kind) || !mediaKindIsVideo(source.Kind) {
			continue
		}
		if _, exists := knownQuality[source.SourceID]; exists {
			continue
		}
		degradation = append(degradation, recordingpipeline.VideoDegradation{SourceID: source.SourceID, Kind: string(source.Kind), PlaceholderMS: visibleMilliseconds(visualSourceSpans(request.Presentation, source.SourceID), 0, request.DurationMS)})
	}
	sort.Slice(degradation, func(i, j int) bool { return degradation[i].SourceID < degradation[j].SourceID })
	if len(sources) == 0 && len(request.IncludedSourceKinds) == 0 {
		return Result{}, fmt.Errorf("%w: recording has no decodable video or audio", ErrDecode)
	}
	discontinuities = append(discontinuities, expandObservedGaps(gaps, sources)...)
	discontinuities = bindDiscontinuities(discontinuities, sources)
	if len(discontinuities) > recordingpresentation.MaximumEvents {
		return Result{}, fmt.Errorf("%w: discontinuity count exceeds bound", ErrOutputLimit)
	}
	if err := os.RemoveAll(spoolDirectory); err != nil {
		return Result{}, fmt.Errorf("remove RTP spool: %w", err)
	}

	mix, err := writeMix(ctx, runner, ffmpegPath, temporaryDirectory, sources, request.DurationMS)
	if err != nil {
		return Result{}, err
	}
	index := Index{
		SchemaVersion: SchemaVersion,
		RecordingID:   request.RecordingID,
		EpisodeID:     request.EpisodeID,
		Clock: Clock{
			Origin: "capture_ready", Timebase: "recording_relative_ms",
			OriginAuthorityID: request.OriginAuthorityID,
			CaptureEpoch:      request.CaptureEpoch, DurationMS: request.DurationMS,
		},
		Sources: sources, Mix: mix, Discontinuities: discontinuities,
	}
	if err := validateIndex(temporaryDirectory, index); err != nil {
		return Result{}, err
	}
	if err := enforceOutputLimit(temporaryDirectory); err != nil {
		return Result{}, err
	}
	indexBytes, err := json.Marshal(index)
	if err != nil {
		return Result{}, fmt.Errorf("encode decoded media index: %w", err)
	}
	indexBytes = append(indexBytes, '\n')
	indexTemporaryPath := filepath.Join(temporaryDirectory, ".decoded_media.json.tmp")
	if err := os.WriteFile(indexTemporaryPath, indexBytes, 0o600); err != nil {
		return Result{}, fmt.Errorf("write decoded media index: %w", err)
	}
	if err := os.Rename(indexTemporaryPath, filepath.Join(temporaryDirectory, IndexFileName)); err != nil {
		return Result{}, fmt.Errorf("publish decoded media index: %w", err)
	}
	if err := syncTree(temporaryDirectory); err != nil {
		return Result{}, err
	}
	if err := os.Rename(temporaryDirectory, outputDirectory); err != nil {
		return Result{}, fmt.Errorf("publish decoded media directory: %w", err)
	}
	if err := syncDirectory(parent); err != nil {
		return Result{}, errors.Join(err, removeAllWithContext(outputDirectory, "remove unpublished decoded media directory"))
	}
	digest := sha256.Sum256(indexBytes)
	return Result{
		VideoDegradation: degradation, Index: index, IndexPath: filepath.Join(outputDirectory, IndexFileName),
		IndexSHA256: hex.EncodeToString(digest[:]),
	}, nil
}

func validateRequest(ctx context.Context, request Request) error {
	if ctx == nil || strings.TrimSpace(request.RecordingID) == "" || strings.TrimSpace(request.EpisodeID) == "" ||
		strings.TrimSpace(request.TenantID) == "" || strings.TrimSpace(request.Environment) == "" ||
		strings.TrimSpace(request.OriginAuthorityID) == "" || request.CaptureEpoch <= 0 ||
		request.DurationMS < 0 || request.DurationMS > recordingpipeline.MaximumRecordingDuration.Milliseconds() ||
		strings.TrimSpace(request.OutputDirectory) == "" || len(request.DataKeys) == 0 || len(request.Bundles) > MaximumBundleFiles {
		return ErrInvalidRequest
	}
	keyEpochs := make(map[int64]struct{}, len(request.DataKeys))
	for _, key := range request.DataKeys {
		if key.CaptureEpoch <= 0 || key.CaptureEpoch > request.CaptureEpoch || len(key.Plaintext) != 32 {
			return ErrInvalidRequest
		}
		if _, exists := keyEpochs[key.CaptureEpoch]; exists {
			return ErrInvalidRequest
		}
		keyEpochs[key.CaptureEpoch] = struct{}{}
	}
	if err := request.Presentation.Validate(); err != nil {
		return fmt.Errorf("%w: presentation: %v", ErrInvalidRequest, err)
	}
	included := make(map[recordingpresentation.MediaKind]struct{}, len(request.IncludedSourceKinds))
	for _, kind := range request.IncludedSourceKinds {
		if kind != recordingpresentation.MediaKindMicrophone && kind != recordingpresentation.MediaKindCamera && kind != recordingpresentation.MediaKindScreenShare {
			return fmt.Errorf("%w: included source kind", ErrInvalidRequest)
		}
		if _, exists := included[kind]; exists {
			return fmt.Errorf("%w: duplicate included source kind", ErrInvalidRequest)
		}
		included[kind] = struct{}{}
	}
	clock := request.Presentation.Clock
	if request.Presentation.RecordingID != request.RecordingID || request.Presentation.EpisodeID != request.EpisodeID ||
		clock.Origin != "capture_ready" || clock.Timebase != "recording_relative_ms" ||
		clock.OriginAuthorityID != request.OriginAuthorityID || clock.CaptureEpoch != request.CaptureEpoch ||
		clock.DurationMillis != request.DurationMS {
		return fmt.Errorf("%w: presentation authority mismatch", ErrInvalidRequest)
	}
	return nil
}

func (request Request) includesSource(kind recordingpresentation.MediaKind) bool {
	if len(request.IncludedSourceKinds) == 0 {
		return true
	}
	for _, included := range request.IncludedSourceKinds {
		if included == kind {
			return true
		}
	}
	return false
}

func presentationCatalog(timeline recordingpresentation.Timeline) (map[sourceIdentity]recordingpresentation.MediaSource, error) {
	sources := make([]recordingpresentation.MediaSource, 0, len(timeline.Initial.Media)+len(timeline.Events))
	sources = append(sources, timeline.Initial.Media...)
	for _, event := range timeline.Events {
		switch value := event.(type) {
		case recordingpresentation.MediaSourceChangedEvent:
			sources = append(sources, value.Source)
		case *recordingpresentation.MediaSourceChangedEvent:
			if value != nil {
				sources = append(sources, value.Source)
			}
		}
	}
	catalog := make(map[sourceIdentity]recordingpresentation.MediaSource, len(sources))
	bySourceID := make(map[string]recordingpresentation.MediaSource, len(sources))
	for _, source := range sources {
		identity := sourceIdentity{trackID: source.TrackID, epoch: uint64(source.Epoch)}
		if existing, exists := catalog[identity]; exists && existing.SourceID != source.SourceID {
			return nil, fmt.Errorf("%w: presentation track identity is ambiguous", ErrInvalidRequest)
		}
		if existing, exists := bySourceID[source.SourceID]; exists && !sameMediaSourceIdentity(existing, source) {
			return nil, fmt.Errorf("%w: presentation source identity changed", ErrInvalidRequest)
		}
		catalog[identity] = source
		bySourceID[source.SourceID] = source
	}
	return catalog, nil
}

func sameMediaSourceIdentity(left, right recordingpresentation.MediaSource) bool {
	return left.SourceID == right.SourceID && left.ParticipantID == right.ParticipantID &&
		left.ParticipantGeneration == right.ParticipantGeneration && left.Kind == right.Kind &&
		left.TrackID == right.TrackID && left.Epoch == right.Epoch
}
