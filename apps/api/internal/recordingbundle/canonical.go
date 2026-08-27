package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

const maxCanonicalBytes = int(MaxContentBytes*2 + 1_000_000)

type contentMaterial struct {
	Fragments      []RTPFragment         `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
}

type envelopeMaterial struct {
	Version        string          `json:"version"`
	Manifest       Manifest        `json:"manifest"`
	Content        contentMaterial `json:"content"`
	ManifestDigest string          `json:"manifest_digest"`
	ContentDigest  string          `json:"content_digest"`
}

type wireBundle struct {
	Version        string                `json:"version"`
	Manifest       Manifest              `json:"manifest"`
	Fragments      []RTPFragment         `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
	ManifestDigest string                `json:"manifest_digest"`
	ContentDigest  string                `json:"content_digest"`
	BundleDigest   string                `json:"bundle_digest"`
}

// Encode returns canonical JSON bytes. Arrays are normalized into a stable
// order and every digest is recomputed from the normalized logical content.
func Encode(bundle Bundle) ([]byte, error) {
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return nil, err
	}
	content := contentMaterial{
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
	}
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("encode content: %w", err)
	}
	contentDigest := digestHex(contentBytes)
	normalized.Manifest.ContentSHA256 = contentDigest
	manifestBytes, err := json.Marshal(normalized.Manifest)
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	manifestDigest := digestHex(manifestBytes)
	envelope := envelopeMaterial{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Content:        content,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
	}
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("encode envelope: %w", err)
	}
	envelopeDigest := digestHex(envelopeBytes)
	wire := wireBundle{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
		BundleDigest:   envelopeDigest,
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("encode bundle: %w", err)
	}
	if len(encoded) > maxCanonicalBytes {
		return nil, fmt.Errorf("%w: canonical bytes=%d limit=%d", ErrContentLimit, len(encoded), maxCanonicalBytes)
	}
	return encoded, nil
}

// Decode strictly validates one canonical envelope. Whitespace is accepted at
// the JSON boundary, but unknown and duplicate object fields are rejected.
func Decode(encoded []byte) (Bundle, error) {
	if len(encoded) == 0 || len(encoded) > maxCanonicalBytes {
		return Bundle{}, fmt.Errorf("%w: encoded size is invalid", ErrInvalidBundle)
	}
	if err := rejectDuplicateJSONKeys(encoded); err != nil {
		return Bundle{}, err
	}
	var wire wireBundle
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return Bundle{}, fmt.Errorf("%w: %v", ErrUnknownField, err)
		}
		return Bundle{}, fmt.Errorf("%w: decode: %v", ErrInvalidBundle, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Bundle{}, fmt.Errorf("%w: trailing JSON value", ErrInvalidBundle)
		}
		return Bundle{}, fmt.Errorf("%w: trailing data: %v", ErrInvalidBundle, err)
	}
	if wire.Version != Version || wire.Manifest.Version != Version {
		return Bundle{}, fmt.Errorf("%w: version=%q manifest=%q", ErrUnknownBundleVersion, wire.Version, wire.Manifest.Version)
	}
	bundle := Bundle(wire)
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return Bundle{}, err
	}
	content := contentMaterial{
		Fragments:      normalized.Fragments,
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
	}
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: content: %v", ErrInvalidBundle, err)
	}
	contentDigest := digestHex(contentBytes)
	if bundle.ContentDigest != contentDigest || normalized.Manifest.ContentSHA256 != contentDigest {
		return Bundle{}, fmt.Errorf("%w: content", ErrDigestMismatch)
	}
	manifestBytes, err := json.Marshal(normalized.Manifest)
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: manifest: %v", ErrInvalidBundle, err)
	}
	manifestDigest := digestHex(manifestBytes)
	if bundle.ManifestDigest != manifestDigest {
		return Bundle{}, fmt.Errorf("%w: manifest", ErrDigestMismatch)
	}
	envelopeBytes, err := json.Marshal(envelopeMaterial{
		Version:        normalized.Version,
		Manifest:       normalized.Manifest,
		Content:        content,
		ManifestDigest: manifestDigest,
		ContentDigest:  contentDigest,
	})
	if err != nil {
		return Bundle{}, fmt.Errorf("%w: envelope: %v", ErrInvalidBundle, err)
	}
	if bundle.BundleDigest != digestHex(envelopeBytes) {
		return Bundle{}, fmt.Errorf("%w: envelope", ErrDigestMismatch)
	}
	normalized.ManifestDigest = manifestDigest
	normalized.ContentDigest = contentDigest
	normalized.BundleDigest = bundle.BundleDigest
	return cloneBundle(normalized), nil
}

// CanonicalBytes is a method form useful at worker call sites.
func (b Bundle) CanonicalBytes() ([]byte, error) { return Encode(b) }

// ContentChecksum returns the SHA-256 checksum of the canonical content body,
// excluding the manifest and envelope digest fields.
func ContentChecksum(b Bundle) (string, error) {
	encoded, err := Encode(b)
	if err != nil {
		return "", err
	}
	decoded, err := Decode(encoded)
	if err != nil {
		return "", err
	}
	return decoded.ContentDigest, nil
}

func digestHex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func normalizeBundle(input Bundle) (Bundle, error) {
	bundle := cloneBundle(input)
	if bundle.Version != Version {
		return Bundle{}, fmt.Errorf("%w: bundle version %q", ErrUnknownBundleVersion, bundle.Version)
	}
	if err := bundle.Manifest.validate(); err != nil {
		return Bundle{}, err
	}
	if bundle.Fragments == nil {
		bundle.Fragments = make([]RTPFragment, 0)
	}
	if bundle.TrackTimeline == nil {
		bundle.TrackTimeline = make([]TrackTimelineEvent, 0)
	}
	if bundle.LayoutTimeline == nil {
		bundle.LayoutTimeline = make([]LayoutTimelineEvent, 0)
	}
	if bundle.Gaps == nil {
		bundle.Gaps = make([]Gap, 0)
	}
	if len(bundle.Fragments) > MaxTracks {
		return Bundle{}, fmt.Errorf("%w: track count=%d limit=%d", ErrContentLimit, len(bundle.Fragments), MaxTracks)
	}
	if len(bundle.TrackTimeline) > MaxTimelineEvents || len(bundle.LayoutTimeline) > MaxTimelineEvents {
		return Bundle{}, fmt.Errorf("%w: timeline count exceeds limit", ErrContentLimit)
	}
	if len(bundle.Gaps) > MaxGaps {
		return Bundle{}, fmt.Errorf("%w: gap count exceeds limit", ErrContentLimit)
	}
	seenTracks := make(map[string]struct{}, len(bundle.Fragments))
	packetCount := 0
	contentBytes := 0
	for index := range bundle.Fragments {
		fragment := &bundle.Fragments[index]
		if err := fragment.Track.validate(); err != nil {
			return Bundle{}, err
		}
		trackKey := trackIdentityKey(fragment.Track)
		if _, exists := seenTracks[trackKey]; exists {
			return Bundle{}, fmt.Errorf("%w: duplicate track fragment", ErrInvalidBundle)
		}
		seenTracks[trackKey] = struct{}{}
		if len(fragment.Packets) == 0 {
			return Bundle{}, fmt.Errorf("%w: empty track fragment", ErrInvalidBundle)
		}
		packetCount += len(fragment.Packets)
		if packetCount > MaxPackets {
			return Bundle{}, fmt.Errorf("%w: packet count=%d limit=%d", ErrPacketLimit, packetCount, MaxPackets)
		}
		for packetIndex := range fragment.Packets {
			packet := &fragment.Packets[packetIndex]
			if uint16(packet.ExtendedSequenceNumber) != packet.SequenceNumber {
				return Bundle{}, fmt.Errorf("%w: extended RTP sequence does not match wire sequence", ErrInvalidBundle)
			}
			if len(packet.Payload) > MaxPacketPayloadBytes {
				return Bundle{}, fmt.Errorf("%w: packet payload=%d limit=%d", ErrContentLimit, len(packet.Payload), MaxPacketPayloadBytes)
			}
			contentBytes += len(packet.Payload)
			if contentBytes > int(MaxContentBytes) {
				return Bundle{}, fmt.Errorf("%w: payload bytes=%d limit=%d", ErrContentLimit, contentBytes, MaxContentBytes)
			}
			packet.Payload = append([]byte(nil), packet.Payload...)
		}
		sort.SliceStable(fragment.Packets, func(i, j int) bool {
			return packetLess(fragment.Packets[i], fragment.Packets[j])
		})
	}
	sort.Slice(bundle.Fragments, func(i, j int) bool {
		return trackIdentityLess(bundle.Fragments[i].Track, bundle.Fragments[j].Track)
	})
	for _, event := range bundle.TrackTimeline {
		if !event.Kind.valid() {
			return Bundle{}, fmt.Errorf("%w: unknown track event %q", ErrInvalidBundle, event.Kind)
		}
		if event.MonotonicMilliseconds < 0 || event.MediaMilliseconds < 0 {
			return Bundle{}, fmt.Errorf("%w: track event time", ErrNonMonotonicTime)
		}
		if err := event.Track.validate(); err != nil {
			return Bundle{}, err
		}
	}
	sort.SliceStable(bundle.TrackTimeline, func(i, j int) bool {
		return trackEventLess(bundle.TrackTimeline[i], bundle.TrackTimeline[j])
	})
	for _, event := range bundle.LayoutTimeline {
		if !event.Kind.valid() || event.Revision == 0 || event.Layout == "" {
			return Bundle{}, fmt.Errorf("%w: layout event is invalid", ErrInvalidBundle)
		}
		if event.MonotonicMilliseconds < 0 || event.MediaMilliseconds < 0 {
			return Bundle{}, fmt.Errorf("%w: layout event time", ErrNonMonotonicTime)
		}
	}
	sort.SliceStable(bundle.LayoutTimeline, func(i, j int) bool {
		return layoutEventLess(bundle.LayoutTimeline[i], bundle.LayoutTimeline[j])
	})
	for _, gap := range bundle.Gaps {
		if err := gap.validate(); err != nil {
			return Bundle{}, err
		}
	}
	sort.SliceStable(bundle.Gaps, func(i, j int) bool { return gapLess(bundle.Gaps[i], bundle.Gaps[j]) })
	if len(bundle.Fragments) == 0 && len(bundle.TrackTimeline) == 0 && len(bundle.LayoutTimeline) == 0 && len(bundle.Gaps) == 0 {
		return Bundle{}, ErrEmptyBundle
	}
	if bundle.Manifest.MonotonicRange.EndMilliseconds-bundle.Manifest.MonotonicRange.StartMilliseconds > MaxBundleDurationMilliseconds || bundle.Manifest.MediaRange.EndMilliseconds-bundle.Manifest.MediaRange.StartMilliseconds > MaxBundleDurationMilliseconds {
		return Bundle{}, ErrDurationLimit
	}
	return bundle, nil
}

func cloneBundle(input Bundle) Bundle {
	output := input
	output.Fragments = make([]RTPFragment, len(input.Fragments))
	for index, fragment := range input.Fragments {
		output.Fragments[index].Track = fragment.Track
		output.Fragments[index].Packets = make([]RTPPacket, len(fragment.Packets))
		for packetIndex, packet := range fragment.Packets {
			output.Fragments[index].Packets[packetIndex] = packet
			output.Fragments[index].Packets[packetIndex].Payload = append([]byte(nil), packet.Payload...)
		}
	}
	output.TrackTimeline = append([]TrackTimelineEvent(nil), input.TrackTimeline...)
	output.LayoutTimeline = append([]LayoutTimelineEvent(nil), input.LayoutTimeline...)
	output.Gaps = append([]Gap(nil), input.Gaps...)
	return output
}

func trackIdentityKey(track TrackIdentity) string {
	return track.TrackID + "\x00" + fmt.Sprintf("%020d", track.Epoch) + "\x00" + track.MID + "\x00" + track.Codec + "\x00" + track.Layer
}

func trackIdentityLess(left, right TrackIdentity) bool {
	if left.TrackID != right.TrackID {
		return left.TrackID < right.TrackID
	}
	if left.Epoch != right.Epoch {
		return left.Epoch < right.Epoch
	}
	if left.MID != right.MID {
		return left.MID < right.MID
	}
	if left.Codec != right.Codec {
		return left.Codec < right.Codec
	}
	return left.Layer < right.Layer
}

func packetLess(left, right RTPPacket) bool {
	if left.ExtendedSequenceNumber != right.ExtendedSequenceNumber {
		return left.ExtendedSequenceNumber < right.ExtendedSequenceNumber
	}
	if left.Timestamp != right.Timestamp {
		return left.Timestamp < right.Timestamp
	}
	if left.SSRC != right.SSRC {
		return left.SSRC < right.SSRC
	}
	if left.PayloadType != right.PayloadType {
		return left.PayloadType < right.PayloadType
	}
	if left.Marker != right.Marker {
		return !left.Marker
	}
	return bytes.Compare(left.Payload, right.Payload) < 0
}

func trackEventLess(left, right TrackTimelineEvent) bool {
	if left.MonotonicMilliseconds != right.MonotonicMilliseconds {
		return left.MonotonicMilliseconds < right.MonotonicMilliseconds
	}
	if left.MediaMilliseconds != right.MediaMilliseconds {
		return left.MediaMilliseconds < right.MediaMilliseconds
	}
	if left.Kind != right.Kind {
		return left.Kind < right.Kind
	}
	if trackIdentityLess(left.Track, right.Track) {
		return true
	}
	if trackIdentityLess(right.Track, left.Track) {
		return false
	}
	return left.Reason < right.Reason
}

func layoutEventLess(left, right LayoutTimelineEvent) bool {
	if left.MonotonicMilliseconds != right.MonotonicMilliseconds {
		return left.MonotonicMilliseconds < right.MonotonicMilliseconds
	}
	if left.MediaMilliseconds != right.MediaMilliseconds {
		return left.MediaMilliseconds < right.MediaMilliseconds
	}
	if left.Kind != right.Kind {
		return left.Kind < right.Kind
	}
	if left.Revision != right.Revision {
		return left.Revision < right.Revision
	}
	return left.Layout < right.Layout
}

func gapLess(left, right Gap) bool {
	if left.StartMonotonicMilliseconds != right.StartMonotonicMilliseconds {
		return left.StartMonotonicMilliseconds < right.StartMonotonicMilliseconds
	}
	if left.EndMonotonicMilliseconds != right.EndMonotonicMilliseconds {
		return left.EndMonotonicMilliseconds < right.EndMonotonicMilliseconds
	}
	if left.StartMediaMilliseconds != right.StartMediaMilliseconds {
		return left.StartMediaMilliseconds < right.StartMediaMilliseconds
	}
	if left.EndMediaMilliseconds != right.EndMediaMilliseconds {
		return left.EndMediaMilliseconds < right.EndMediaMilliseconds
	}
	if left.ReplacementAttempt != right.ReplacementAttempt {
		return left.ReplacementAttempt < right.ReplacementAttempt
	}
	if left.Terminal != right.Terminal {
		return !left.Terminal
	}
	return left.Reason < right.Reason
}

// rejectDuplicateJSONKeys catches an ambiguity that encoding/json otherwise
// silently accepts when the same object field appears more than once.
func rejectDuplicateJSONKeys(encoded []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if err := walkJSONValue(decoder); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidBundle, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing JSON", ErrInvalidBundle)
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				if _, exists := seen[name]; exists {
					return fmt.Errorf("duplicate field %q", name)
				}
				seen[name] = struct{}{}
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("object is not closed")
			}
		case '[':
			for decoder.More() {
				if err := walkJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("array is not closed")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
		}
	}
	return nil
}
