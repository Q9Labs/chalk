package sdktelemetry

import "reflect"

// StatsWindow summarizes one window of the device's getStats polling. A field is
// absent when the browser did not report it, never zero. A window with Gap set
// measured nothing: the client could not, and says why.
type StatsWindow struct {
	WindowMS            int64    `json:"window_ms"`
	Gap                 string   `json:"gap,omitempty"`
	ConnectionType      string   `json:"connection_type,omitempty"`
	LocalCandidateType  string   `json:"local_candidate_type,omitempty"`
	RemoteCandidateType string   `json:"remote_candidate_type,omitempty"`
	RelayProtocol       string   `json:"relay_protocol,omitempty"`
	RTTMS               *int64   `json:"rtt_ms,omitempty"`
	SendBitrateKbps     *int64   `json:"send_bitrate_kbps,omitempty"`
	SendLossPct         *float64 `json:"send_loss_pct,omitempty"`
	SendJitterMS        *int64   `json:"send_jitter_ms,omitempty"`
	SendLayer           string   `json:"send_layer,omitempty"`
	RecvBitrateKbps     *int64   `json:"recv_bitrate_kbps,omitempty"`
	RecvLossPct         *float64 `json:"recv_loss_pct,omitempty"`
	RecvJitterMS        *int64   `json:"recv_jitter_ms,omitempty"`
	RecvHeight          *int64   `json:"recv_height,omitempty"`
	FreezeCount         *int64   `json:"freeze_count,omitempty"`
	FreezeMS            *int64   `json:"freeze_ms,omitempty"`
	// RecvPausedVideos counts remote videos the SFU had paused for network at the
	// end of the window. Only an SDK on a plane that reports subscription state sends it.
	RecvPausedVideos *int64 `json:"recv_paused_videos,omitempty"`
	// RecvHiddenVideos counts remote videos the viewer chose not to receive at the end of
	// the window because their tiles were hidden or off screen. They send nothing on purpose.
	RecvHiddenVideos *int64 `json:"recv_hidden_videos,omitempty"`
	// Tracks is what each remote track did in the window.
	Tracks []TrackWindow `json:"tracks,omitempty"`
}

// TrackWindow is one remote track in one window. MID is the media id the SFU
// logs for the same subscription, so a deaf listener joins to what the SFU sent.
type TrackWindow struct {
	MID  string `json:"mid"`
	Kind string `json:"kind"`
	// Packets and Lost count what arrived and what was missing in the window.
	Packets *int64 `json:"packets,omitempty"`
	Lost    *int64 `json:"lost,omitempty"`
	// AudioEnergy is the energy that arrived in the window in thousandths of the
	// browser's totalAudioEnergy unit: it tells silence from speech, and carries no audio.
	AudioEnergy *int64 `json:"audio_energy,omitempty"`
	Playout     string `json:"playout,omitempty"`
}

// check covers what a stats window needs beyond the checks of its fields: a gap
// window measures nothing, and a measured window has a bounded length and names its tracks.
func (s StatsWindow) check() string {
	if s.Gap != "" {
		if s.WindowMS < 1 || s.WindowMS > MaxMilliseconds {
			return "window_ms_range"
		}
		bare := StatsWindow{WindowMS: s.WindowMS, Gap: s.Gap}
		if !reflect.DeepEqual(s, bare) {
			return "gap_measured"
		}
		return ""
	}
	if s.WindowMS < MinWindowMS || s.WindowMS > MaxWindowMS {
		return "window_ms_range"
	}
	if s.ConnectionType == "" {
		return "connection_type_missing"
	}
	for _, track := range s.Tracks {
		if track.MID == "" || track.Kind == "" {
			return "tracks_incomplete"
		}
	}
	return ""
}
