package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"
)

func buildIDs(value dataset) datasetIDs {
	organization := value.Manifest.Records.Organizations[0]
	ids := datasetIDs{
		OrganizationID: organizationID(organization.ExternalKey).String(),
		TenantIDs:      make(map[string]string, len(value.Manifest.Records.Tenants)),
		SpaceIDs:       make(map[string]string, len(value.Manifest.Records.Spaces)),
		UserIDs:        make(map[string]string, len(value.Manifest.Records.Users)),
		IdentityIDs:    make(map[string]string, len(value.Manifest.Records.Users)+len(value.Manifest.Records.Agents)),
		AgentIDs:       make(map[string]string, len(value.Manifest.Records.Agents)),
		EpisodeIDs:     make(map[string]string, len(value.Manifest.Records.Episodes)),
		ParticipantIDs: make(map[string]string, len(value.Manifest.Records.Episodes)*5),
		SceneIDs:       make(map[string]string, len(value.Manifest.Records.Episodes)),
		RecordingIDs:   make(map[string]string, len(value.Manifest.Records.Episodes)),
		TranscriptIDs:  make(map[string]string, len(value.Manifest.Records.Episodes)),
	}
	for _, item := range value.Manifest.Records.Tenants {
		ids.TenantIDs[item.ExternalKey] = deterministicID("tenant", item.ExternalKey).String()
	}
	for _, item := range value.Manifest.Records.Spaces {
		ids.SpaceIDs[item.ExternalKey] = deterministicID("space", item.ExternalKey).String()
	}
	for _, item := range value.Manifest.Records.Users {
		ids.UserIDs[item.ExternalKey] = deterministicID("user", item.ExternalKey).String()
		ids.IdentityIDs[item.ExternalKey] = deterministicID("identity", item.ExternalKey).String()
	}
	for _, item := range value.Manifest.Records.Agents {
		ids.AgentIDs[item.ExternalKey] = deterministicID("identity", item.ExternalKey).String()
		ids.IdentityIDs[item.ExternalKey] = ids.AgentIDs[item.ExternalKey]
	}
	for _, item := range value.Manifest.Records.Episodes {
		ids.EpisodeIDs[item.ExternalKey] = deterministicID("episode", item.ExternalKey).String()
		ids.SceneIDs[item.ExternalKey] = deterministicID("scene", item.ExternalKey).String()
		ids.RecordingIDs[item.ExternalKey] = deterministicID("recording", item.ExternalKey).String()
		ids.TranscriptIDs[item.ExternalKey] = deterministicID("transcript", item.ExternalKey).String()
		for _, participantKey := range append(append([]string{}, item.ParticipantKeys...), item.AgentKey) {
			ids.ParticipantIDs[participantKeyFor(item.ExternalKey, participantKey)] = deterministicID("participant", item.ExternalKey+"/"+participantKey).String()
		}
	}
	return ids
}

func organizationID(key string) uuid.UUID {
	return deterministicID("organization", key)
}

func deterministicID(kind, key string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("chalk/showcase-v1/"+kind+"/"+key))
}

func participantKeyFor(episodeKey, identityKey string) string {
	return episodeKey + "/" + identityKey
}

func participantID(ids datasetIDs, episodeKey, identityKey string) uuid.UUID {
	return uuid.MustParse(ids.ParticipantIDs[participantKeyFor(episodeKey, identityKey)])
}

func roleCapabilities() map[string][]string {
	return map[string][]string{
		"owner": {
			"publishAudio", "publishVideo", "publishScreen", "subscribe",
			"raiseHand", "renameSelf", "sendChat", "sendReaction",
			"drawWhiteboard", "manageWhiteboard", "manageAdmission",
			"assignRoles", "muteOthers", "stopVideoOthers", "stopScreenOthers",
			"requestMediaOthers", "removeParticipant", "manageRecording",
			"startEpisode", "extendEpisode", "endEpisode", "manageMembers",
			"clearSpaceContent",
		},
		"collaborator": {
			"publishAudio", "publishVideo", "publishScreen", "subscribe",
			"raiseHand", "renameSelf", "sendChat", "sendReaction", "drawWhiteboard",
		},
		"observer": {"subscribe", "sendReaction"},
	}
}

func identityRole(value string) string {
	if value == "guest" || value == "reviewer" {
		return "observer"
	}
	return "collaborator"
}

func participantRole(value string) string {
	return identityRole(value)
}

func snapshotForEpisode(value dataset, ids datasetIDs, item episode, participants []snapshotParticipant, status string, revision int) (map[string]any, []byte, [32]byte, error) {
	capabilities := roleCapabilities()
	sort.Slice(participants, func(left, right int) bool {
		return participants[left].ParticipantID < participants[right].ParticipantID
	})
	encodedParticipants := make([]any, 0, len(participants))
	for _, participant := range participants {
		encodedParticipants = append(encodedParticipants, map[string]any{
			"participant_id":     participant.ParticipantID,
			"display_name":       participant.DisplayName,
			"hand_raised":        false,
			"role":               participant.Role,
			"capabilities":       capabilities[participant.Role],
			"admission_revision": participant.AdmissionRevision,
		})
	}
	space := value.SpaceByKey[item.SpaceKey]
	deadline := item.OccurredAt.Add(24 * time.Hour)
	snapshot := map[string]any{
		"control_revision":     revision,
		"state_schema_version": 1,
		"status":               status,
		"admission_policy":     admissionPolicy(space),
		"deadline_at_ms":       deadline.UnixMilli(),
		"deadline_generation":  1,
		"role_capabilities":    capabilities,
		"recording":            nil,
		"admission_requests":   []any{},
		"participants":         encodedParticipants,
	}
	canonical, err := json.Marshal(snapshot)
	if err != nil {
		return nil, nil, [32]byte{}, err
	}
	digestInput := make([]byte, 0, len("chalk-sync-state-v1")+4+len(canonical))
	digestInput = append(digestInput, "chalk-sync-state-v1"...)
	version := make([]byte, 4)
	binary.BigEndian.PutUint32(version, 1)
	digestInput = append(digestInput, version...)
	digestInput = append(digestInput, canonical...)
	digest := sha256.Sum256(digestInput)
	wire := make(map[string]any, len(snapshot)+1)
	for key, entry := range snapshot {
		wire[key] = entry
	}
	wire["state_digest"] = hex.EncodeToString(digest[:])
	wireSnapshot, err := json.Marshal(wire)
	if err != nil {
		return nil, nil, [32]byte{}, err
	}
	return snapshot, wireSnapshot, digest, nil
}

type snapshotParticipant struct {
	ParticipantID     string
	DisplayName       string
	Role              string
	AdmissionRevision int
}

func admissionPolicy(value space) string {
	if value.Visibility == "invited-only" {
		return "members_only"
	}
	return "open"
}
