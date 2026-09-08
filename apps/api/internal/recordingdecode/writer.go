package recordingdecode

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

const spoolRecordHeaderBytes = 22

type sourceIdentity struct {
	trackID string
	epoch   uint64
}

type sourceState struct {
	presentation recordingpresentation.MediaSource
	track        recordingbundle.TrackIdentity
	spoolPath    string
	hasPacket    bool
	lastSequence uint64
}

type observedGap struct {
	startMS int64
	endMS   int64
	reason  string
}

// Write verifies and decrypts recording_bundle.v1 objects, decodes their RTP
// into browser-seekable per-source media, and atomically publishes one
// decoded_media.v1 directory. It never infers source identity from an object
// path: every bundle track must join the authenticated presentation timeline
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
	discontinuities := make([]Discontinuity, 0)
	for _, state := range stateValues {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		source, sourceDiscontinuities, err := decodeSource(ctx, runner, ffmpegPath, temporaryDirectory, mediaDirectory, state, request.DurationMS)
		if err != nil {
			return Result{}, err
		}
		sources = append(sources, source)
		discontinuities = append(discontinuities, sourceDiscontinuities...)
	}
	discontinuities = append(discontinuities, expandObservedGaps(gaps, sources)...)
	discontinuities = normalizeDiscontinuities(discontinuities)
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
		Index: index, IndexPath: filepath.Join(outputDirectory, IndexFileName),
		IndexSHA256: hex.EncodeToString(digest[:]),
	}, nil
}

func validateRequest(ctx context.Context, request Request) error {
	if ctx == nil || strings.TrimSpace(request.RecordingID) == "" || strings.TrimSpace(request.EpisodeID) == "" ||
		strings.TrimSpace(request.TenantID) == "" || strings.TrimSpace(request.Environment) == "" ||
		strings.TrimSpace(request.OriginAuthorityID) == "" || request.CaptureEpoch <= 0 ||
		request.DurationMS < 0 || request.DurationMS > 2*60*60*1_000 ||
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
	clock := request.Presentation.Clock
	if request.Presentation.RecordingID != request.RecordingID || request.Presentation.EpisodeID != request.EpisodeID ||
		clock.Origin != "capture_ready" || clock.Timebase != "recording_relative_ms" ||
		clock.OriginAuthorityID != request.OriginAuthorityID || clock.CaptureEpoch != request.CaptureEpoch ||
		clock.DurationMillis != request.DurationMS {
		return fmt.Errorf("%w: presentation authority mismatch", ErrInvalidRequest)
	}
	return nil
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
		recoveryBoundary := false
		if previous != nil {
			if err := recordingbundle.ValidateSequence(*previous, bundle); err != nil {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: sequence %d: %v", ErrInvalidBundle, file.Sequence, err)
			}
			if bundle.Manifest.CaptureEpoch < previous.Manifest.CaptureEpoch {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: capture epoch regressed", ErrInvalidBundle)
			}
			if previousDigest != "" && previousDigest != bundle.Manifest.RecorderEnvelopeDigest {
				recoveryBoundary = true
				gaps = append(gaps, observedGap{startMS: previous.Manifest.MediaRange.EndMilliseconds, endMS: bundle.Manifest.MediaRange.StartMilliseconds, reason: "attempt_recovery"})
			}
		}
		for _, gap := range bundle.Gaps {
			gaps = append(gaps, observedGap{startMS: gap.StartMediaMilliseconds, endMS: gap.EndMediaMilliseconds, reason: discontinuityReason(gap.Reason, gap.ReplacementAttempt > 0)})
		}
		for _, fragment := range bundle.Fragments {
			source, exists := catalog[sourceIdentity{trackID: fragment.Track.TrackID, epoch: fragment.Track.Epoch}]
			if !exists {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: track %q epoch %d is absent from presentation", ErrInvalidBundle, fragment.Track.TrackID, fragment.Track.Epoch)
			}
			if err := validateTrackKind(source.Kind, fragment.Track.Codec); err != nil {
				clearBundle(&bundle)
				return nil, nil, err
			}
			state := states[source.SourceID]
			if state == nil {
				state = &sourceState{presentation: source, track: fragment.Track, spoolPath: filepath.Join(spoolDirectory, source.SourceID+".rtp")}
				states[source.SourceID] = state
			} else if state.track != fragment.Track {
				clearBundle(&bundle)
				return nil, nil, fmt.Errorf("%w: source track identity mutated", ErrInvalidBundle)
			}
			if err := appendFragment(state, fragment, recoveryBoundary); err != nil {
				clearBundle(&bundle)
				return nil, nil, err
			}
		}
		previousCopy := bundle
		previous = &previousCopy
		previousDigest = bundle.Manifest.RecorderEnvelopeDigest
		clearBundle(&bundle)
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
		context.JobID != file.CaptureJobID || context.BundleSchema != recordingbundle.Version {
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

func appendFragment(state *sourceState, fragment recordingbundle.RTPFragment, allowSequenceReset bool) (resultErr error) {
	file, err := os.OpenFile(state.spoolPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open RTP spool: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close RTP spool"))
	}()
	buffer := bufio.NewWriterSize(file, 64<<10)
	for index, packet := range fragment.Packets {
		if state.hasPacket && packet.ExtendedSequenceNumber <= state.lastSequence && !(allowSequenceReset && index == 0) {
			return fmt.Errorf("%w: source RTP sequence is not increasing", ErrInvalidBundle)
		}
		if len(packet.Payload) > recordingbundle.MaxPacketPayloadBytes {
			return fmt.Errorf("%w: source RTP payload exceeds bound", ErrInvalidBundle)
		}
		if err := writeSpoolPacket(buffer, packet); err != nil {
			return fmt.Errorf("write RTP spool: %w", err)
		}
		state.hasPacket = true
		state.lastSequence = packet.ExtendedSequenceNumber
	}
	if err := buffer.Flush(); err != nil {
		return fmt.Errorf("flush RTP spool: %w", err)
	}
	return nil
}

func writeSpoolPacket(writer io.Writer, packet recordingbundle.RTPPacket) error {
	var header [spoolRecordHeaderBytes]byte
	binary.BigEndian.PutUint64(header[0:8], packet.ExtendedSequenceNumber)
	binary.BigEndian.PutUint32(header[8:12], packet.Timestamp)
	binary.BigEndian.PutUint32(header[12:16], packet.SSRC)
	header[16] = packet.PayloadType
	if packet.Marker {
		header[17] = 1
	}
	binary.BigEndian.PutUint32(header[18:22], uint32(len(packet.Payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(packet.Payload)
	return err
}

func readSpoolPacket(reader *bufio.Reader) (recordingbundle.RTPPacket, error) {
	var header [spoolRecordHeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return recordingbundle.RTPPacket{}, err
	}
	payloadLength := binary.BigEndian.Uint32(header[18:22])
	if payloadLength > recordingbundle.MaxPacketPayloadBytes {
		return recordingbundle.RTPPacket{}, fmt.Errorf("%w: corrupt RTP spool payload", ErrDecode)
	}
	payload := make([]byte, int(payloadLength))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return recordingbundle.RTPPacket{}, err
	}
	return recordingbundle.RTPPacket{
		ExtendedSequenceNumber: binary.BigEndian.Uint64(header[0:8]), SequenceNumber: uint16(binary.BigEndian.Uint64(header[0:8])),
		Timestamp: binary.BigEndian.Uint32(header[8:12]), SSRC: binary.BigEndian.Uint32(header[12:16]),
		PayloadType: header[16], Marker: header[17] == 1, Payload: payload,
	}, nil
}

func readRegularFile(path string, total *int64) (encoded []byte, resultErr error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: bundle path is required", ErrInvalidRequest)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
		return nil, fmt.Errorf("%w: bundle path is not a regular file", ErrInvalidRequest)
	}
	if info.Size() > MaximumInputBytes-*total {
		return nil, fmt.Errorf("%w: encrypted bundle input exceeds bound", ErrInvalidBundle)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read encrypted bundle: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close encrypted bundle"))
	}()
	encoded, err = io.ReadAll(io.LimitReader(file, info.Size()+1))
	if err != nil {
		return nil, fmt.Errorf("read encrypted bundle: %w", err)
	}
	if int64(len(encoded)) != info.Size() {
		return nil, fmt.Errorf("%w: encrypted bundle size changed while reading", ErrInvalidBundle)
	}
	*total += int64(len(encoded))
	return encoded, nil
}

func closeFileWithContext(file *os.File, operation string) error {
	if file == nil {
		return nil
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func removeAllWithContext(path, operation string) error {
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func removeFileWithContext(path, operation string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
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

func discontinuityReason(reason string, recovery bool) string {
	lower := strings.ToLower(reason)
	switch {
	case recovery || strings.Contains(lower, "attempt") || strings.Contains(lower, "replacement"):
		return "attempt_recovery"
	case strings.Contains(lower, "packet") || strings.Contains(lower, "loss"):
		return "packet_loss"
	case strings.Contains(lower, "decode"):
		return "decode_failure"
	default:
		return "source_gap"
	}
}

func expandObservedGaps(gaps []observedGap, sources []Source) []Discontinuity {
	output := make([]Discontinuity, 0)
	for _, gap := range gaps {
		start := maxInt64(0, gap.startMS)
		end := maxInt64(start, gap.endMS)
		for _, source := range sources {
			overlapStart := maxInt64(start, source.StartMS)
			overlapEnd := minInt64(end, source.EndMS)
			if overlapEnd <= overlapStart {
				continue
			}
			output = append(output, Discontinuity{SourceID: source.SourceID, TrackID: source.TrackID, TrackEpoch: source.TrackEpoch, StartMS: overlapStart, EndMS: overlapEnd, Reason: gap.reason})
		}
	}
	return output
}

func normalizeDiscontinuities(values []Discontinuity) []Discontinuity {
	filtered := values[:0]
	seen := make(map[Discontinuity]struct{}, len(values))
	for _, value := range values {
		if value.EndMS <= value.StartMS {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		filtered = append(filtered, value)
	}
	sort.Slice(filtered, func(i, j int) bool {
		left, right := filtered[i], filtered[j]
		if left.StartMS != right.StartMS {
			return left.StartMS < right.StartMS
		}
		if left.SourceID != right.SourceID {
			return left.SourceID < right.SourceID
		}
		if left.EndMS != right.EndMS {
			return left.EndMS < right.EndMS
		}
		return left.Reason < right.Reason
	})
	return filtered
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

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func ticksToMillisecondsFloor(ticks uint64, rate uint64) int64 {
	return int64(ticks * 1_000 / rate)
}

func ticksToMillisecondsCeil(ticks uint64, rate uint64) int64 {
	return int64((ticks*1_000 + rate - 1) / rate)
}
