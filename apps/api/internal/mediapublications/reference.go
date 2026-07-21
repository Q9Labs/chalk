package mediapublications

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

const publicationReferencePrefix = "chalk_pub_v1."

type Reference struct {
	Version                  int
	ConnectionID             string
	MID                      string
	TrackName                string
	ParticipantGeneration    int64
	HasMID                   bool
	HasParticipantGeneration bool
}

type referencePayload struct {
	ConnectionID          string `json:"c"`
	MID                   string `json:"m"`
	TrackName             string `json:"t"`
	ParticipantGeneration int64  `json:"g"`
}

func ParseReference(publicationID string) (Reference, error) {
	if publicationID == "" || strings.TrimSpace(publicationID) != publicationID {
		return Reference{}, ErrInvalidPublication
	}
	if strings.HasPrefix(publicationID, publicationReferencePrefix) {
		return parseVersionOneReference(strings.TrimPrefix(publicationID, publicationReferencePrefix))
	}
	if strings.HasPrefix(publicationID, "chalk_pub_") {
		return Reference{}, ErrInvalidPublication
	}
	connectionID, trackName, found := strings.Cut(publicationID, "|")
	if !found || connectionID == "" || trackName == "" || strings.Contains(trackName, "|") ||
		strings.TrimSpace(connectionID) != connectionID || strings.TrimSpace(trackName) != trackName {
		return Reference{}, ErrInvalidPublication
	}
	return Reference{
		Version:                  0,
		ConnectionID:             connectionID,
		TrackName:                trackName,
		HasMID:                   false,
		HasParticipantGeneration: false,
	}, nil
}

func encodeReference(connectionID, mid, trackName string, participantGeneration int64) string {
	payload, err := json.Marshal(referencePayload{
		ConnectionID:          connectionID,
		MID:                   mid,
		TrackName:             trackName,
		ParticipantGeneration: participantGeneration,
	})
	if err != nil {
		panic(err)
	}
	return publicationReferencePrefix + base64.RawURLEncoding.EncodeToString(payload)
}

func parseVersionOneReference(encoded string) (Reference, error) {
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != encoded {
		return Reference{}, ErrInvalidPublication
	}
	var decoded referencePayload
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return Reference{}, ErrInvalidPublication
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Reference{}, ErrInvalidPublication
	}
	if decoded.ConnectionID == "" || decoded.MID == "" || decoded.TrackName == "" ||
		decoded.ParticipantGeneration <= 0 ||
		strings.TrimSpace(decoded.ConnectionID) != decoded.ConnectionID ||
		strings.TrimSpace(decoded.MID) != decoded.MID ||
		strings.TrimSpace(decoded.TrackName) != decoded.TrackName {
		return Reference{}, ErrInvalidPublication
	}
	return Reference{
		Version:                  1,
		ConnectionID:             decoded.ConnectionID,
		MID:                      decoded.MID,
		TrackName:                decoded.TrackName,
		ParticipantGeneration:    decoded.ParticipantGeneration,
		HasMID:                   true,
		HasParticipantGeneration: true,
	}, nil
}
