package tests

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestMicrophoneObservationsFollowLiveRTP(t *testing.T) {
	mic := newParkedMic(t)
	mic.pull()
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(mic.connA+"\x00"+audioName)))
	eventually(t, "received audio and matching ingress and forwarding witnesses", 25*time.Second, func() bool {
		var ingress, forward bool
		for _, line := range strings.Split(mic.svc.logs.String(), "\n") {
			if !strings.Contains(line, "audio_track_key="+key) {
				continue
			}
			ingress = ingress || (strings.Contains(line, "name=audio.sfu_ingress") && strings.Contains(line, "participant_id=alice") && strings.Contains(line, "audio_observation=ingress_packets"))
			forward = forward || (strings.Contains(line, "name=audio.sfu_forward") && strings.Contains(line, "participant_id=bob") && strings.Contains(line, "audio_peer_id=alice") && strings.Contains(line, "audio_observation=forwarded"))
		}
		return ingress && forward && mic.received.count(webrtc.RTPCodecTypeAudio) >= 30
	})
}
