package recordingpresentation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"
)

const sourceIDDomain = "recording_presentation_source.v1"

var ErrInvalidSourceIdentity = errors.New("invalid recording presentation source identity")

type MediaKind string

const (
	MediaKindMicrophone  MediaKind = "microphone"
	MediaKindCamera      MediaKind = "camera"
	MediaKindScreenShare MediaKind = "screen_share"
)

type MediaSourceIdentity struct {
	RecordingID           string
	ParticipantID         string
	ParticipantGeneration int64
	Kind                  MediaKind
	TrackID               string
	Epoch                 int64
}

// SourceID derives the cross-runtime identity used to bind a presentation
// source to decoded media. Every UTF-8 part, including the domain, is framed
// by a four-byte unsigned big-endian length before hashing.
func SourceID(input MediaSourceIdentity) (string, error) {
	if input.RecordingID == "" || input.ParticipantID == "" || input.TrackID == "" ||
		input.ParticipantGeneration <= 0 || input.Epoch <= 0 ||
		(input.Kind != MediaKindMicrophone && input.Kind != MediaKindCamera && input.Kind != MediaKindScreenShare) {
		return "", ErrInvalidSourceIdentity
	}

	digest := sha256.New()
	for _, value := range []string{
		sourceIDDomain,
		input.RecordingID,
		input.ParticipantID,
		strconv.FormatInt(input.ParticipantGeneration, 10),
		string(input.Kind),
		input.TrackID,
		strconv.FormatInt(input.Epoch, 10),
	} {
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(value)))
		_, _ = digest.Write(length[:])
		_, _ = digest.Write([]byte(value))
	}
	return "rps_" + hex.EncodeToString(digest.Sum(nil)), nil
}
