package recordingbundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	// CBN2: magic, big-endian JSON header length, canonical JSON metadata,
	// then track-ordered records (big-endian length, 20 RTP bytes, raw payload).
	binaryBundleMagic = "CBN2"
	maxBinaryHeader   = 1 << 20
	packetHeaderBytes = 20
)

type binaryFragment struct {
	Track       TrackIdentity `json:"track"`
	PacketCount int           `json:"packet_count"`
}

type binaryContent struct {
	Fragments      []binaryFragment      `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
}

type binaryHeader struct {
	Version        string        `json:"version"`
	Manifest       Manifest      `json:"manifest"`
	Content        binaryContent `json:"content"`
	ManifestDigest string        `json:"manifest_digest"`
	ContentDigest  string        `json:"content_digest"`
	BundleDigest   string        `json:"bundle_digest,omitempty"`
}

func encodeBinary(bundle Bundle) ([]byte, error) {
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return nil, err
	}
	content := binaryContent{
		Fragments:      make([]binaryFragment, 0, len(normalized.Fragments)),
		TrackTimeline:  normalized.TrackTimeline,
		LayoutTimeline: normalized.LayoutTimeline,
		Gaps:           normalized.Gaps,
	}
	var packets bytes.Buffer
	var header [packetHeaderBytes]byte
	var length [4]byte
	for _, fragment := range normalized.Fragments {
		content.Fragments = append(content.Fragments, binaryFragment{Track: fragment.Track, PacketCount: len(fragment.Packets)})
		for _, packet := range fragment.Packets {
			binary.BigEndian.PutUint32(length[:], uint32(packetHeaderBytes+len(packet.Payload)))
			packets.Write(length[:])
			binary.BigEndian.PutUint16(header[0:2], packet.SequenceNumber)
			binary.BigEndian.PutUint64(header[2:10], packet.ExtendedSequenceNumber)
			binary.BigEndian.PutUint32(header[10:14], packet.Timestamp)
			binary.BigEndian.PutUint32(header[14:18], packet.SSRC)
			header[18] = packet.PayloadType
			header[19] = 0
			if packet.Marker {
				header[19] = 1
			}
			packets.Write(header[:])
			packets.Write(packet.Payload)
		}
	}
	contentBytes, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("encode binary content metadata: %w", err)
	}
	contentHash := sha256.New()
	contentHash.Write(contentBytes)
	contentHash.Write(packets.Bytes())
	contentDigest := fmt.Sprintf("%x", contentHash.Sum(nil))
	normalized.Manifest.ContentSHA256 = contentDigest
	manifestBytes, err := json.Marshal(normalized.Manifest)
	if err != nil {
		return nil, fmt.Errorf("encode binary manifest: %w", err)
	}
	wire := binaryHeader{Version: Version, Manifest: normalized.Manifest, Content: content,
		ManifestDigest: digestHex(manifestBytes), ContentDigest: contentDigest}
	unsignedHeader, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("encode binary header: %w", err)
	}
	bundleHash := sha256.New()
	bundleHash.Write(unsignedHeader)
	bundleHash.Write(packets.Bytes())
	wire.BundleDigest = fmt.Sprintf("%x", bundleHash.Sum(nil))
	headerBytes, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("encode binary header: %w", err)
	}
	if len(headerBytes) > maxBinaryHeader || len(headerBytes)+packets.Len()+8 > maxCanonicalBytes {
		return nil, fmt.Errorf("%w: binary bundle exceeds limit", ErrContentLimit)
	}
	encoded := make([]byte, 8, 8+len(headerBytes)+packets.Len())
	copy(encoded, binaryBundleMagic)
	binary.BigEndian.PutUint32(encoded[4:8], uint32(len(headerBytes)))
	encoded = append(encoded, headerBytes...)
	encoded = append(encoded, packets.Bytes()...)
	return encoded, nil
}

func decodeBinary(encoded []byte) (Bundle, error) {
	if len(encoded) < 8 || len(encoded) > maxCanonicalBytes {
		return Bundle{}, ErrInvalidBundle
	}
	headerLength := int(binary.BigEndian.Uint32(encoded[4:8]))
	if headerLength == 0 || headerLength > maxBinaryHeader || headerLength > len(encoded)-8 {
		return Bundle{}, ErrInvalidBundle
	}
	headerBytes := encoded[8 : 8+headerLength]
	if err := rejectDuplicateJSONKeys(headerBytes); err != nil {
		return Bundle{}, err
	}
	var wire binaryHeader
	decoder := json.NewDecoder(bytes.NewReader(headerBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return Bundle{}, fmt.Errorf("%w: binary header: %v", ErrInvalidBundle, err)
	}
	if wire.Version != Version || wire.Manifest.Version != Version {
		return Bundle{}, ErrUnknownBundleVersion
	}
	if len(wire.Content.Fragments) > MaxTracks || len(wire.Content.TrackTimeline) > MaxTimelineEvents ||
		len(wire.Content.LayoutTimeline) > MaxTimelineEvents || len(wire.Content.Gaps) > MaxGaps {
		return Bundle{}, ErrContentLimit
	}
	packetCount := 0
	for _, fragment := range wire.Content.Fragments {
		if fragment.PacketCount < 0 || fragment.PacketCount > MaxPackets-packetCount {
			return Bundle{}, ErrPacketLimit
		}
		packetCount += fragment.PacketCount
	}
	packetBytes := encoded[8+headerLength:]
	contentBytes, err := json.Marshal(wire.Content)
	if err != nil {
		return Bundle{}, ErrInvalidBundle
	}
	contentHash := sha256.New()
	contentHash.Write(contentBytes)
	contentHash.Write(packetBytes)
	if wire.ContentDigest != fmt.Sprintf("%x", contentHash.Sum(nil)) || wire.Manifest.ContentSHA256 != wire.ContentDigest {
		return Bundle{}, ErrDigestMismatch
	}
	manifestBytes, err := json.Marshal(wire.Manifest)
	if err != nil || wire.ManifestDigest != digestHex(manifestBytes) {
		return Bundle{}, ErrDigestMismatch
	}
	unsigned := wire
	unsigned.BundleDigest = ""
	unsignedBytes, err := json.Marshal(unsigned)
	if err != nil {
		return Bundle{}, ErrInvalidBundle
	}
	bundleHash := sha256.New()
	bundleHash.Write(unsignedBytes)
	bundleHash.Write(packetBytes)
	if wire.BundleDigest != fmt.Sprintf("%x", bundleHash.Sum(nil)) {
		return Bundle{}, ErrDigestMismatch
	}
	bundle := Bundle{Version: wire.Version, Manifest: wire.Manifest,
		TrackTimeline: wire.Content.TrackTimeline, LayoutTimeline: wire.Content.LayoutTimeline, Gaps: wire.Content.Gaps,
		ManifestDigest: wire.ManifestDigest, ContentDigest: wire.ContentDigest, BundleDigest: wire.BundleDigest,
		Fragments: make([]RTPFragment, 0, len(wire.Content.Fragments))}
	reader := bytes.NewReader(packetBytes)
	contentSize := 0
	for _, fragment := range wire.Content.Fragments {
		decoded := RTPFragment{Track: fragment.Track, Packets: make([]RTPPacket, 0, fragment.PacketCount)}
		for range fragment.PacketCount {
			var length [4]byte
			if _, err := io.ReadFull(reader, length[:]); err != nil {
				return Bundle{}, ErrInvalidBundle
			}
			recordLength := int(binary.BigEndian.Uint32(length[:]))
			if recordLength < packetHeaderBytes || recordLength > packetHeaderBytes+MaxPacketPayloadBytes || recordLength > reader.Len() {
				return Bundle{}, ErrInvalidBundle
			}
			var header [packetHeaderBytes]byte
			if _, err := io.ReadFull(reader, header[:]); err != nil || header[19] > 1 {
				return Bundle{}, ErrInvalidBundle
			}
			payloadSize := recordLength - packetHeaderBytes
			contentSize += payloadSize
			if contentSize > int(MaxContentBytes) {
				return Bundle{}, ErrContentLimit
			}
			payload := make([]byte, payloadSize)
			if _, err := io.ReadFull(reader, payload); err != nil {
				return Bundle{}, ErrInvalidBundle
			}
			decoded.Packets = append(decoded.Packets, RTPPacket{
				SequenceNumber: binary.BigEndian.Uint16(header[0:2]), ExtendedSequenceNumber: binary.BigEndian.Uint64(header[2:10]),
				Timestamp: binary.BigEndian.Uint32(header[10:14]), SSRC: binary.BigEndian.Uint32(header[14:18]),
				PayloadType: header[18], Marker: header[19] == 1, Payload: payload,
			})
		}
		bundle.Fragments = append(bundle.Fragments, decoded)
	}
	if reader.Len() != 0 {
		return Bundle{}, ErrInvalidBundle
	}
	normalized, err := normalizeBundle(bundle)
	if err != nil {
		return Bundle{}, err
	}
	canonical, err := encodeBinary(normalized)
	if err != nil {
		return Bundle{}, err
	}
	if !bytes.Equal(canonical, encoded) {
		return Bundle{}, errors.Join(ErrInvalidBundle, ErrDigestMismatch)
	}
	return cloneBundle(normalized), nil
}
