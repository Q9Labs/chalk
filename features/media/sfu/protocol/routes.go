package protocol

import (
	"net/url"
	"regexp"
)

// Prefix starts every control route except readiness and health.
const Prefix = "/" + Version

const (
	RouteHealth = "/healthz"
	RouteReady  = "/readyz"

	RouteSessions        = Prefix + "/sessions"
	RouteEpisodesEnd     = Prefix + "/episodes/end"
	RouteEpisodesReserve = Prefix + "/episodes/reserve"
	RouteEpisodesRetire  = Prefix + "/episodes/retire"
	RouteEpisodesSources = Prefix + "/episodes/sources"
	RouteDrain           = Prefix + "/drain"
	RouteUndrain         = Prefix + "/undrain"
)

// Session actions: each is a route under one session, named by its connection ID.
const (
	ActionTracks      = "tracks"
	ActionUpdateTrack = "tracks/update"
	ActionCloseTracks = "tracks/close"
	ActionRenegotiate = "renegotiate"
	ActionInspect     = "inspect"
	ActionRemove      = "remove"
)

// SessionConnectionWildcard names the connection ID in a server's route pattern.
const SessionConnectionWildcard = "connectionId"

// SessionActionPattern is the server's route pattern for one session action.
func SessionActionPattern(action string) string {
	return RouteSessions + "/{" + SessionConnectionWildcard + "}/" + action
}

// SessionActionRoute is the path a caller posts to for one session action.
func SessionActionRoute(connectionID, action string) string {
	return RouteSessions + "/" + url.PathEscape(connectionID) + "/" + action
}

// MaxSDPBytes bounds an offer before the node parses it. A browser offer lists every section it
// ever opened, live and closed: about 7.5 KB per camera-and-microphone guest, so a call with ten
// camera guests passes 64 KiB. It must stay below the node's request body limit
// (SFU_MAX_REQUEST_BYTES), which carries the offer inside JSON.
const MaxSDPBytes = 256 << 10

// IdentifierPattern is what a Tenant, Episode, Participant, operation ID or MID may be.
var IdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// IdentifierRule is the sentence that tells a caller what IdentifierPattern accepts.
const IdentifierRule = "1-128 characters of letters, digits, '.', '_', ':' or '-'"
