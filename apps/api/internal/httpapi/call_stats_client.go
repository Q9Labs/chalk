package httpapi

import (
	"net/http"
	"regexp"
	"strings"
)

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

// callStatsOrigin names where the call came from without an address: the edge's
// country code and coarse browser and OS families from the User-Agent.
func callStatsOrigin(r *http.Request) []any {
	country := r.Header.Get("CF-IPCountry")
	if !countryCode.MatchString(country) {
		country = "unknown"
	}
	family, system := clientFamilies(r.UserAgent())
	return []any{"country", country, "client_family", family, "client_os", system}
}

// userAgentMatch names a client family or OS when the User-Agent holds any of its markers.
type userAgentMatch struct {
	name    string
	markers []string
}

// Order matters: the first match wins, so Edge and Chrome markers precede the generic Safari one.
var (
	clientFamilyMatches = []userAgentMatch{
		{"edge", []string{"Edg/", "EdgA/", "EdgiOS/"}},
		{"opera", []string{"OPR/"}},
		{"samsung", []string{"SamsungBrowser/"}},
		{"firefox", []string{"Firefox/", "FxiOS/"}},
		{"chrome", []string{"Chrome/", "CriOS/"}},
		{"safari", []string{"Safari/"}},
		{"native", []string{"CFNetwork", "okhttp", "ReactNative", "Hermes"}},
	}
	clientSystemMatches = []userAgentMatch{
		{"android", []string{"Android", "okhttp"}},
		{"ios", []string{"iPhone", "iPad", "iPod", "CFNetwork"}},
		{"windows", []string{"Windows"}},
		{"chromeos", []string{"CrOS"}},
		{"macos", []string{"Mac OS X", "Macintosh"}},
		{"linux", []string{"Linux", "X11"}},
	}
)

func clientFamilies(userAgent string) (family, system string) {
	return firstUserAgentMatch(userAgent, clientFamilyMatches), firstUserAgentMatch(userAgent, clientSystemMatches)
}

func firstUserAgentMatch(userAgent string, matches []userAgentMatch) string {
	for _, match := range matches {
		for _, marker := range match.markers {
			if strings.Contains(userAgent, marker) {
				return match.name
			}
		}
	}
	return "other"
}

func (s callStatsSample) logAttributes() []any {
	attributes := []any{"elapsed_ms", s.ElapsedMS, "window_ms", s.WindowMS, "connection_type", s.ConnectionType}
	for key, value := range map[string]string{"local_candidate_type": s.LocalCandidateType, "remote_candidate_type": s.RemoteCandidateType, "relay_protocol": s.RelayProtocol, "send_layer": s.SendLayer} {
		if value != "" {
			attributes = append(attributes, key, value)
		}
	}
	for key, value := range map[string]*int64{"rtt_ms": s.RTTMS, "send_bitrate_kbps": s.SendBitrateKbps, "send_jitter_ms": s.SendJitterMS, "recv_bitrate_kbps": s.RecvBitrateKbps, "recv_jitter_ms": s.RecvJitterMS, "recv_height": s.RecvHeight, "freeze_count": s.FreezeCount, "freeze_ms": s.FreezeMS, "recv_paused_videos": s.RecvPausedVideos, "recv_hidden_videos": s.RecvHiddenVideos} {
		if value != nil {
			attributes = append(attributes, key, *value)
		}
	}
	for key, value := range map[string]*float64{"send_loss_pct": s.SendLossPct, "recv_loss_pct": s.RecvLossPct} {
		if value != nil {
			attributes = append(attributes, key, *value)
		}
	}
	return attributes
}
