package media

import "github.com/q9labs/chalk/features/media/sfu/internal/obs"

// The node's diagnosis trail is the only log that leaves the node, and this file is its contract:
// each event's name, the fields it may carry and where each field's value comes from. The emitters
// name events by these constants, and the telemetry exporter reads the same tables, so a new field
// ships once it has a row here and not before.

// FieldSource says where an exported field's value comes from. A value a Participant or a peer
// chooses (an SDP rid, a name, an address, any text) has no source and cannot be exported: the node
// maps it to an enum or counts it first, and the raw value stays in the journal.
type FieldSource string

const (
	// ServerAssigned values are made by the node: its incarnation, a transceiver mid.
	ServerAssigned FieldSource = "server-assigned"
	// Enum values come from a closed set in the node's code: a state, a cause, a reason.
	Enum FieldSource = "enum"
	// Number values are counts, sizes, rates and flags the node measured.
	Number FieldSource = "number"
	// RestrictedID values are ids the API issued or the node checked against a fixed pattern
	// (letters, digits and . _ : -; hex and dashes for trace and journey ids).
	RestrictedID FieldSource = "restricted id"
)

const (
	EventSessionRegistered      = "sfu.session.registered"
	EventSessionRefused         = "sfu.session.refused"
	EventAdmissionRefused       = "sfu.admission.refused"
	EventSessionClosed          = "sfu.session.closed"
	EventPeerState              = "sfu.peer.state"
	EventICEState               = "sfu.ice.state"
	EventDTLSState              = "sfu.dtls.state"
	EventPublicationStarted     = "sfu.publication.started"
	EventPublicationStopped     = "sfu.publication.stopped"
	EventSubscriptionStarted    = "sfu.subscription.started"
	EventSubscriptionStopped    = "sfu.subscription.stopped"
	EventSubscriptionPaused     = "sfu.subscription.paused"
	EventSubscriptionResumed    = "sfu.subscription.resumed"
	EventSubscriptionLayer      = "sfu.subscription.layer"
	EventSubscriptionCongestion = "sfu.subscription.congestion"
	EventCameraPlan             = "sfu.camera.plan"
	EventSourceLeaseOpened      = "sfu.source.lease_opened"
	EventSourceLeaseLost        = "sfu.source.lease_lost"
	EventNegotiationFailed      = "sfu.negotiation.failed"
	EventControlFailed          = "sfu.control.failed"
	EventMediaIngress           = "sfu.media.ingress"
	EventMediaEgress            = "sfu.media.egress"
	EventMediaTransport         = "sfu.media.transport"
	EventPublicationHeld        = "sfu.publication.held"
	EventUnmuteVoiced           = "sfu.unmute.first_voiced"
	EventUnmuteForwarded        = "sfu.unmute.first_forwarded"
)

// FieldSources lists every field that may leave the node, and where its value comes from.
var FieldSources = map[string]FieldSource{
	"event": Enum, "tenant_id": RestrictedID, "episode_id": RestrictedID, "participant_id": RestrictedID,
	"generation": Number, "connection_id": RestrictedID, "session_kind": Enum, "node_incarnation": ServerAssigned,
	"trace_id": RestrictedID, "journey_id": RestrictedID,

	"allocation": Number, "code": Enum, "reason": Enum, "sessions": Number, "cause": Enum,
	"outcome": Enum, "connected": Number, "connect_ms": Number, "disconnects": Number, "outage_ms": Number,
	"packets": Number, "bytes": Number, "lost": Number, "repaired": Number, "nack_requested": Number,
	"keyframe_repairs": Number, "pli_sent": Number, "jitter_ms": Number, "bitrate_bps": Number, "layers": Number,
	"layers_active": Number, "held": Number, "final": Number, "paused_subscriptions": Number, "high_layer": Number,
	"low_layer": Number, "pli_received": Number, "fir_received": Number, "nack_received": Number, "rtt_ms": Number,
	"queued_bytes": Number, "feedback_age_ms": Number, "sent_audio": Number, "sent_video": Number,
	"sent_repair": Number, "sent_probe": Number, "dropped": Number, "repairs_cut": Number,
	"step": Enum, "operation": Enum, "status": Number,
	"last_ice_state": Enum, "last_peer_state": Enum,
	"lifetime_ms": Number, "publications": Number, "subscriptions": Number, "state": Enum, "path": Enum, "protocol": Enum,
	"source": Enum, "media_kind": Enum, "publisher_id": RestrictedID, "mid": ServerAssigned,
	"was": Enum, "layer": Enum, "level": Enum, "ceiling_packets": Number, "revision": Number,
	"estimate_bps": Number, "proven_bps": Number, "delivered_share": Number,
	"probing": Number, "host_pressure": Number, "acked_bps": Number, "loss_share": Number, "lossy": Number,
	"trend": Enum, "decrease_cause": Enum, "decrease_ago_ms": Number, "decrease_from_bps": Number,
	"decrease_to_bps": Number, "decrease_acked_bps": Number,
	"unmute_seq": Number, "since_unmute_ms": Number, "since_voiced_ms": Number,
	obs.FieldKind: Enum, obs.FieldEventID: ServerAssigned, obs.FieldSourceID: ServerAssigned,
	obs.FieldSeq: Number, obs.FieldSchemaVer: Enum, obs.FieldModule: Enum, obs.FieldEnv: Enum,
	obs.FieldReleaseSHA: ServerAssigned, obs.FieldClockState: Enum, obs.FieldEstServerMs: Number, obs.FieldMediaConnectionID: RestrictedID,
	obs.FieldAudioObservation: Enum, obs.FieldAudioTrackKey: ServerAssigned, obs.FieldAudioSampleMs: Number, obs.FieldAudioPeerID: RestrictedID,
}

// IDFields name who and where an event happened. Every event may carry them.
var IDFields = []string{
	"event", "tenant_id", "episode_id", "participant_id", "generation",
	"connection_id", "session_kind", "node_incarnation", "trace_id", "journey_id",
}

// KernelFields keep the envelope the diagnose reader uses to bind, time and cite facts.
var KernelFields = []string{
	obs.FieldKind, obs.FieldEventID, obs.FieldSourceID, obs.FieldSeq, obs.FieldSchemaVer,
	obs.FieldModule, obs.FieldEnv, obs.FieldReleaseSHA, obs.FieldClockState, obs.FieldEstServerMs, obs.FieldMediaConnectionID,
}

// KernelEventFields only admits explicitly listed kernel records, not arbitrary names.
var KernelEventFields = map[string][]string{
	obs.EventAudioSfuIngress: {obs.FieldAudioObservation, obs.FieldAudioTrackKey, obs.FieldAudioSampleMs},
	obs.EventAudioSfuForward: {obs.FieldAudioObservation, obs.FieldAudioTrackKey, obs.FieldAudioSampleMs, obs.FieldAudioPeerID},
}

// EventFields maps each exportable event to the fields it adds to IDFields. Every field has a row
// in FieldSources. An error string has no row, and neither has a rid: the layer events carry
// `layer`, an enum the node derives from the rid.
var EventFields = map[string][]string{
	EventSessionRegistered: {"allocation"},
	EventSessionRefused:    {"code"},
	EventAdmissionRefused:  {"reason", "sessions"},
	EventSessionClosed: {
		"cause", "outcome", "connected", "lifetime_ms", "publications", "subscriptions", "connect_ms",
		"disconnects", "outage_ms", "last_ice_state", "last_peer_state",
	},
	EventPeerState:           {"state", "connect_ms", "outage_ms"},
	EventICEState:            {"state", "path", "protocol"},
	EventDTLSState:           {"state"},
	EventPublicationStarted:  {"source", "media_kind"},
	EventPublicationStopped:  {"source", "media_kind", "reason"},
	EventPublicationHeld:     {"source", "media_kind", "held", "unmute_seq"},
	EventUnmuteVoiced:        {"source", "unmute_seq", "since_unmute_ms"},
	EventUnmuteForwarded:     {"publisher_id", "source", "mid", "unmute_seq", "since_unmute_ms", "since_voiced_ms"},
	EventSubscriptionStarted: {"publisher_id", "source", "media_kind", "mid"},
	EventSubscriptionStopped: {"publisher_id", "source", "media_kind", "mid", "reason"},
	EventSubscriptionPaused:  {"publisher_id", "source", "media_kind", "mid", "reason"},
	EventSubscriptionResumed: {"publisher_id", "source", "media_kind", "mid", "was"},
	EventSubscriptionLayer:   {"publisher_id", "source", "media_kind", "mid", "layer"},
	EventCameraPlan:          {"level", "was", "ceiling_packets"},
	EventSourceLeaseOpened:   {"source", "revision"},
	EventSourceLeaseLost:     {"source", "cause", "revision"},
	EventNegotiationFailed:   {"step", "reason"},
	EventControlFailed:       {"operation", "status", "code"},
	EventMediaIngress: {
		"source", "media_kind", "mid", "packets", "bytes", "lost", "repaired", "nack_requested", "keyframe_repairs",
		"pli_sent", "jitter_ms", "bitrate_bps", "layers", "layers_active", "held", "final",
	},
	EventMediaEgress: {
		"media_kind", "subscriptions", "paused_subscriptions", "high_layer", "low_layer", "pli_received", "fir_received",
		"nack_received", "lost", "jitter_ms", "loss_share", "rtt_ms", "bitrate_bps", "final",
	},
	EventMediaTransport: {
		"estimate_bps", "proven_bps", "queued_bytes", "probing", "feedback_age_ms", "sent_audio", "sent_video",
		"sent_repair", "sent_probe", "dropped", "repairs_cut", "final",
	},
	EventSubscriptionCongestion: {
		"mid", "layer", "reason", "estimate_bps", "proven_bps", "delivered_share", "probing", "host_pressure",
		"acked_bps", "loss_share", "lossy", "trend", "decrease_cause", "decrease_ago_ms", "decrease_from_bps",
		"decrease_to_bps", "decrease_acked_bps",
	},
}
