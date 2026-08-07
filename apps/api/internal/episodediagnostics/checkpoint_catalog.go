package episodediagnostics

import "strings"

// checkpointCatalogEntry mirrors ActionCheckpointContract in the shared
// diagnostics contract. Keep entries ordered: display order is part of the
// debugger's stable operation shape and drives last-confirmed/missing fields.
type checkpointCatalogEntry struct {
	key       string
	class     CheckpointClass
	predicate string
}

func requiredCheckpointCatalog(keys ...string) []checkpointCatalogEntry {
	entries := make([]checkpointCatalogEntry, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, checkpointCatalogEntry{key: key, class: CheckpointRequired})
	}
	return entries
}

func conditionalCheckpointCatalog(key, predicate string) checkpointCatalogEntry {
	return checkpointCatalogEntry{key: key, class: CheckpointConditional, predicate: predicate}
}

var checkpointCatalogOverrides = map[string][]checkpointCatalogEntry{
	"chat.send": {
		{key: "intent", class: CheckpointRequired},
		{key: "validation", class: CheckpointRequired},
		{key: "authorization", class: CheckpointRequired},
		{key: "durable_commit", class: CheckpointRequired},
		{key: "sender_receipt", class: CheckpointRequired},
		{key: "paging_visibility", class: CheckpointRequired},
		conditionalCheckpointCatalog("recipient_projection", "recipient is connected and observable"),
	},
	"chat.retry": {
		{key: "retry_link", class: CheckpointRequired},
		{key: "durable_commit", class: CheckpointRequired},
		{key: "sender_receipt", class: CheckpointRequired},
	},
	"chat.page": {{key: "page_visibility", class: CheckpointRequired}},
	"chat.read": {{key: "read_commit", class: CheckpointRequired}},
	"chat.attachment.prepare": {
		{key: "validation", class: CheckpointRequired},
		{key: "storage_prepare", class: CheckpointRequired},
	},
	"chat.attachment.commit": {
		{key: "storage_commit", class: CheckpointRequired},
		{key: "sender_receipt", class: CheckpointRequired},
	},
	"chat.attachment.fail": {{key: "failure", class: CheckpointRequired}},
	"reaction.send": {
		{key: "authorization", class: CheckpointRequired},
		{key: "accepted_commit", class: CheckpointRequired},
		{key: "sender_result", class: CheckpointRequired},
		conditionalCheckpointCatalog("recipient_projection", "recipient is connected and observable"),
	},
	"reaction.dedupe": {{key: "dedupe_key_outcome", class: CheckpointRequired}},
	"reaction.expire": {{key: "server_expiry", class: CheckpointRequired}},
	"screen.start": {
		{key: "permission", class: CheckpointRequired},
		{key: "track_acquisition", class: CheckpointRequired},
		{key: "sync_commit", class: CheckpointRequired},
		{key: "sfu_publication", class: CheckpointRequired},
		conditionalCheckpointCatalog("remote_first_frame", "observable recipient exists"),
	},
	"screen.stop":           {{key: "stop_confirmation", class: CheckpointRequired}},
	"screen.unexpected_end": {{key: "track_end", class: CheckpointRequired}},
	"screen.recover":        {{key: "recovery_terminal", class: CheckpointRequired}},
	"moderation.role.change": {
		{key: "capability_decision", class: CheckpointRequired},
		{key: "command_commit", class: CheckpointRequired},
		conditionalCheckpointCatalog("target_application", "target is observable"),
	},
	"moderation.capability.check": {{key: "capability_decision", class: CheckpointRequired}},
	"moderation.remove": {
		{key: "capability_decision", class: CheckpointRequired},
		{key: "command_commit", class: CheckpointRequired},
		{key: "target_delivery", class: CheckpointRequired},
		conditionalCheckpointCatalog("target_application", "target is observable"),
	},
	"moderation.ban": {
		{key: "capability_decision", class: CheckpointRequired},
		{key: "command_commit", class: CheckpointRequired},
		{key: "target_delivery", class: CheckpointRequired},
		conditionalCheckpointCatalog("target_application", "target is observable"),
	},
	"whiteboard.unsupported": {
		{key: "unsupported", class: CheckpointRequired, predicate: "whiteboard is outside v1"},
	},
}

// checkpointCatalog returns the exact semantic family for every operation in
// ActionOperationKeys. The shared TypeScript catalog uses the same families;
// the parity test loads its generated semantic fixture and checks all 84
// operations, so a newly-added action cannot silently fall back to intent and
// terminal checkpoints.
func checkpointCatalog(operation string) []checkpointCatalogEntry {
	if override, ok := checkpointCatalogOverrides[operation]; ok {
		return append([]checkpointCatalogEntry(nil), override...)
	}

	var keys []string
	switch {
	case strings.HasPrefix(operation, "episode."):
		keys = []string{"policy_snapshot", "authoritative_state", "terminal_reason"}
	case strings.HasPrefix(operation, "access."):
		keys = []string{"request", "auth_decision"}
		if operation == "access.deny" {
			keys = append(keys, "safe_denial")
		} else {
			keys = append(keys, "bound_access_bundle")
		}
	case strings.HasPrefix(operation, "participant."):
		keys = []string{"membership_transition", "participant_result"}
	case strings.HasPrefix(operation, "microphone."), strings.HasPrefix(operation, "camera."):
		keys = []string{"intent", "local_track_state", "sync_commit", "sfu_publication"}
	case strings.HasPrefix(operation, "media_request."):
		keys = []string{"capability_decision", "command_commit", "target_result"}
	case strings.HasPrefix(operation, "sync."):
		keys = []string{"ordered_transition", "restored_cursor", "terminal"}
	case strings.HasPrefix(operation, "admission."):
		keys = []string{"policy_decision", "authoritative_commit", "participant_result"}
	case strings.HasPrefix(operation, "moderation."):
		entries := requiredCheckpointCatalog("capability_decision", "command_commit", "target_delivery")
		entries = append(entries, conditionalCheckpointCatalog("target_application", "target is observable"))
		return entries
	case strings.HasPrefix(operation, "recovery."):
		keys = []string{"retry_link", "restored_state", "budget_terminal"}
	case strings.HasPrefix(operation, "recording."), strings.HasPrefix(operation, "transcription."):
		keys = []string{"authorized_branch", "attempt", "provider_result", "artifact_state"}
	case operation == "cleanup.fan_in", operation == "cleanup.complete":
		keys = []string{"children_terminal", "fan_in_terminal"}
	case strings.HasPrefix(operation, "cleanup."):
		keys = []string{"resource_release", "child_terminal"}
	case strings.HasPrefix(operation, "artifact."):
		keys = []string{"pre_end_slot", "immutable_commit", "branch_terminal"}
	case strings.HasPrefix(operation, "webhook."):
		keys = []string{"signed_attempt", "response_class", "terminal"}
	default:
		// Event extras and future unknown names are still rendered safely. All
		// closed v1 actions above take a semantic family before this fallback.
		keys = []string{"intent", "terminal"}
	}
	return requiredCheckpointCatalog(keys...)
}

func checkpointDetails(kind string, expectation *DiagnosticEventExpectation) []DiagnosticCheckpointDetail {
	definitions := checkpointCatalog(kind)
	checkpoints := make([]DiagnosticCheckpointDetail, 0, len(definitions)+1)
	for index, definition := range definitions {
		checkpoint := DiagnosticCheckpointDetail{
			Key:          definition.key,
			Class:        definition.class,
			DisplayOrder: index,
			State:        CheckpointPending,
			Predicate:    definition.predicate,
		}
		if expectation != nil && expectation.Checkpoint == definition.key {
			checkpoint.DeadlineAt = expectation.DeadlineAt
		}
		checkpoints = append(checkpoints, checkpoint)
	}
	if expectation != nil && expectation.Checkpoint != "" {
		for _, checkpoint := range checkpoints {
			if checkpoint.Key == expectation.Checkpoint {
				return checkpoints
			}
		}
		checkpoints = append(checkpoints, DiagnosticCheckpointDetail{
			Key:          expectation.Checkpoint,
			Class:        expectation.CheckpointClass,
			DisplayOrder: len(checkpoints),
			State:        CheckpointPending,
			DeadlineAt:   expectation.DeadlineAt,
		})
	}
	return checkpoints
}
