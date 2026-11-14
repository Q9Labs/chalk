package media

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
)

// FieldSources lists every field that may leave the node, and where its value comes from.
var FieldSources = map[string]FieldSource{
	"event": Enum, "tenant_id": RestrictedID, "episode_id": RestrictedID, "participant_id": RestrictedID,
	"generation": Number, "connection_id": RestrictedID, "session_kind": Enum, "node_incarnation": ServerAssigned,
	"trace_id": RestrictedID, "journey_id": RestrictedID,

	"allocation": Number, "code": Enum, "reason": Enum, "sessions": Number, "cause": Enum,
	"lifetime_ms": Number, "publications": Number, "subscriptions": Number, "state": Enum, "path": Enum, "protocol": Enum,
	"source": Enum, "media_kind": Enum, "publisher_id": RestrictedID, "mid": ServerAssigned,
	"was": Enum, "layer": Enum, "level": Enum, "ceiling_packets": Number, "revision": Number,
	"estimate_bps": Number, "proven_bps": Number, "delivered_share": Number,
	"probing": Number, "host_pressure": Number, "acked_bps": Number, "loss_share": Number, "lossy": Number,
	"trend": Enum, "decrease_cause": Enum, "decrease_ago_ms": Number, "decrease_from_bps": Number,
	"decrease_to_bps": Number, "decrease_acked_bps": Number,
}

// IDFields name who and where an event happened. Every event may carry them.
var IDFields = []string{
	"event", "tenant_id", "episode_id", "participant_id", "generation",
	"connection_id", "session_kind", "node_incarnation", "trace_id", "journey_id",
}

// EventFields maps each exportable event to the fields it adds to IDFields. Every field has a row
// in FieldSources. An error string has no row, and neither has a rid: the layer events carry
// `layer`, an enum the node derives from the rid.
var EventFields = map[string][]string{
	EventSessionRegistered:   {"allocation"},
	EventSessionRefused:      {"code"},
	EventAdmissionRefused:    {"reason", "sessions"},
	EventSessionClosed:       {"cause", "lifetime_ms", "publications", "subscriptions"},
	EventPeerState:           {"state"},
	EventICEState:            {"state", "path", "protocol"},
	EventDTLSState:           {"state"},
	EventPublicationStarted:  {"source", "media_kind"},
	EventPublicationStopped:  {"source", "media_kind", "reason"},
	EventSubscriptionStarted: {"publisher_id", "source", "media_kind", "mid"},
	EventSubscriptionStopped: {"publisher_id", "source", "media_kind", "mid", "reason"},
	EventSubscriptionPaused:  {"publisher_id", "source", "media_kind", "mid", "reason"},
	EventSubscriptionResumed: {"publisher_id", "source", "media_kind", "mid", "was"},
	EventSubscriptionLayer:   {"publisher_id", "source", "media_kind", "mid", "layer"},
	EventCameraPlan:          {"level", "was", "ceiling_packets"},
	EventSourceLeaseOpened:   {"source", "revision"},
	EventSourceLeaseLost:     {"source", "cause", "revision"},
	EventSubscriptionCongestion: {
		"mid", "layer", "reason", "estimate_bps", "proven_bps", "delivered_share", "probing", "host_pressure",
		"acked_bps", "loss_share", "lossy", "trend", "decrease_cause", "decrease_ago_ms", "decrease_from_bps",
		"decrease_to_bps", "decrease_acked_bps",
	},
}
