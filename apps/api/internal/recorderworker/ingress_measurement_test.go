package recorderworker

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This opt-in harness retains headers and salted fingerprints, never media.
// It runs the production Pion adapter, admission reader and track clock.
func TestIngressMeasurement(t *testing.T) {
	if testing.Short() || os.Getenv("CHALK_RUN_LIVE_SFU_CAPTURE_TEST") != "1" || os.Getenv("CHALK_INGRESS_MEASUREMENT") != "1" {
		t.Skip("explicit isolated local measurement only")
	}
	for _, name := range []string{"INGRESS_APP_ID", "INGRESS_APP_SECRET", "INGRESS_PUBLISHER_SESSION", "INGRESS_TRACK", "INGRESS_OUTPUT"} {
		if os.Getenv(name) == "" {
			t.Fatalf("missing %s", name)
		}
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		t.Fatal(err)
	}
	for _, policy := range []string{"omitted", "explicit"} {
		t.Run(policy, func(t *testing.T) {
			t.Parallel()
			runIngressMeasurement(t, policy, salt)
		})
	}
}

type ingressResponse struct {
	SessionID   string                    `json:"sessionId"`
	Description *captureplane.Description `json:"sessionDescription"`
	Tracks      []struct {
		MID       string `json:"mid"`
		ErrorCode string `json:"errorCode"`
	} `json:"tracks"`
	ErrorCode string `json:"errorCode"`
}

type ingressPolicy struct {
	PreferredRID     string `json:"preferredRid"`
	PriorityOrdering string `json:"priorityOrdering"`
	RIDNotAvailable  string `json:"ridNotAvailable"`
}

type ingressSubscription struct {
	Location  string         `json:"location"`
	SessionID string         `json:"sessionId"`
	TrackName string         `json:"trackName"`
	Simulcast *ingressPolicy `json:"simulcast,omitempty"`
}

func ingressRequest(ctx context.Context, method, path string, body interface{}) (ingressResponse, error) {
	var result ingressResponse
	encoded, err := json.Marshal(body)
	if err != nil {
		return result, err
	}
	if body == nil {
		encoded = nil
	}
	request, err := http.NewRequestWithContext(ctx, method, "https://rtc.live.cloudflare.com/v1/apps/"+os.Getenv("INGRESS_APP_ID")+path, bytes.NewReader(encoded))
	if err != nil {
		return result, err
	}
	request.Header.Set("Authorization", "Bearer "+os.Getenv("INGRESS_APP_SECRET"))
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return result, fmt.Errorf("SFU transport failed: %T", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, fmt.Errorf("SFU HTTP %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return result, err
	}
	if result.ErrorCode != "" {
		return result, fmt.Errorf("SFU error %s", result.ErrorCode)
	}
	for _, track := range result.Tracks {
		if track.ErrorCode != "" {
			return result, fmt.Errorf("SFU track error %s", track.ErrorCode)
		}
	}
	return result, nil
}

type ingressRow struct {
	ArrivalNS           int64   `json:"arrival_ns"`
	ArrivalUnixNS       int64   `json:"arrival_unix_ns"`
	SSRC                uint32  `json:"ssrc"`
	RID                 string  `json:"rid"`
	RepairedRID         string  `json:"repaired_rid"`
	PayloadType         uint8   `json:"pt"`
	Sequence            uint16  `json:"sequence"`
	Timestamp           uint32  `json:"timestamp"`
	RTXSSRC             *uint32 `json:"rtx_ssrc"`
	RTXSequence         *uint16 `json:"rtx_sequence"`
	RTXPayloadType      *uint8  `json:"rtx_pt"`
	PictureID           *uint16 `json:"picture_id"`
	Keyframe            bool    `json:"keyframe"`
	Width               int     `json:"width,omitempty"`
	Height              int     `json:"height,omitempty"`
	Fingerprint         string  `json:"fingerprint"`
	PayloadBytes        int     `json:"payload_bytes"`
	Padding             bool    `json:"padding"`
	Outcome             string  `json:"outcome"`
	Admitted            bool    `json:"admitted"`
	NormalizedTimestamp *uint32 `json:"normalized_timestamp"`
	NegativeOffset      bool    `json:"negative_offset"`
}

type ingressObservedTrack struct {
	CaptureMediaTrack
	start       time.Time
	salt        []byte
	mu          sync.Mutex
	rows        []*ingressRow
	pending     map[*rtp.Packet]*ingressRow
	window      capturePacketWindow
	replay      captureVideoReplayWindow
	ridID       uint8
	repairedRID uint8
}

func (track *ingressObservedTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	packet, attributes, err := track.CaptureMediaTrack.ReadRTP()
	if err != nil || packet == nil {
		return packet, attributes, err
	}
	received := time.Now()
	arrival := received.Sub(track.start).Nanoseconds()
	fingerprint := hmac.New(sha256.New, track.salt)
	fingerprint.Write(packet.Payload)
	row := &ingressRow{ArrivalNS: arrival, SSRC: packet.SSRC, RID: track.RID(), PayloadType: packet.PayloadType, Sequence: packet.SequenceNumber, Timestamp: packet.Timestamp, Fingerprint: hex.EncodeToString(fingerprint.Sum(nil))}
	row.ArrivalUnixNS = received.UnixNano()
	row.PayloadBytes = len(packet.Payload)
	row.Padding = packet.Padding
	if rid := packet.GetExtension(track.ridID); len(rid) > 0 {
		row.RID = string(rid)
	}
	if rid := packet.GetExtension(track.repairedRID); len(rid) > 0 {
		row.RepairedRID = string(rid)
	}
	if value, ok := attributes[webrtc.AttributeRtxSsrc].(uint32); ok {
		row.RTXSSRC = &value
	}
	if value, ok := attributes[webrtc.AttributeRtxSequenceNumber].(uint16); ok {
		row.RTXSequence = &value
	}
	if value, ok := attributes[webrtc.AttributeRtxPayloadType].(uint8); ok {
		row.RTXPayloadType = &value
	}
	var descriptor codecs.VP8Packet
	if payload, decodeErr := descriptor.Unmarshal(packet.Payload); decodeErr == nil {
		if descriptor.I == 1 {
			id := descriptor.PictureID
			row.PictureID = &id
		}
		if descriptor.S == 1 && descriptor.PID == 0 && len(payload) >= 10 && payload[0]&1 == 0 && bytes.Equal(payload[3:6], []byte{0x9d, 0x01, 0x2a}) {
			row.Keyframe = true
			row.Width = (int(payload[6]) | int(payload[7])<<8) & 0x3fff
			row.Height = (int(payload[8]) | int(payload[9])<<8) & 0x3fff
		}
	}
	row.Outcome = "admitted"
	if !track.window.accept(packet.SSRC, packet.SequenceNumber) {
		row.Outcome = "window_rejected"
	} else if !track.replay.accept(packet, packet.SequenceNumber == track.window.sequence.last) {
		row.Outcome = "replay_rejected"
	}
	track.mu.Lock()
	defer track.mu.Unlock()
	if len(track.rows) >= 500000 {
		return nil, nil, fmt.Errorf("ingress packet bound reached")
	}
	track.rows = append(track.rows, row)
	if row.Outcome == "admitted" {
		track.pending[packet] = row
	}
	return packet, attributes, nil
}

func runIngressMeasurement(t *testing.T, policy string, salt []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 210*time.Second)
	defer cancel()
	peer, err := pion.NewPeer(pion.Config{CaptureEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	created, err := ingressRequest(ctx, http.MethodPost, "/sessions/new", nil)
	if err != nil {
		t.Fatal(err)
	}
	subscription := ingressSubscription{Location: "remote", SessionID: os.Getenv("INGRESS_PUBLISHER_SESSION"), TrackName: os.Getenv("INGRESS_TRACK")}
	if policy == "explicit" {
		subscription.Simulcast = &ingressPolicy{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}
	}
	response, err := ingressRequest(ctx, http.MethodPost, "/sessions/"+created.SessionID+"/tracks/new", struct {
		Tracks []ingressSubscription `json:"tracks"`
	}{[]ingressSubscription{subscription}})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Tracks) != 1 || response.Description == nil {
		t.Fatal("missing single track/SDP")
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, err := ingressRequest(cleanupCtx, http.MethodPut, "/sessions/"+created.SessionID+"/tracks/close", struct {
			Tracks []struct {
				MID string `json:"mid"`
			} `json:"tracks"`
			Force bool `json:"force"`
		}{[]struct {
			MID string `json:"mid"`
		}{{response.Tracks[0].MID}}, true})
		if err != nil {
			t.Errorf("detach ingress track: %v", err)
		}
	}()
	participant, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	mid := captureplane.ProviderReference(response.Tracks[0].MID)
	identity := captureplane.PulledCaptureTrack{MID: mid, CaptureTrack: captureplane.CaptureTrack{OwnerReference: "ingress", TrackReference: "synthetic-camera", ParticipantID: participant, ParticipantGeneration: 1, Source: captureplane.TrackSourceCamera, Kind: captureplane.TrackKindVideo, RequestedLayer: captureplane.TrackLayerAuto}}
	if err := peer.RegisterTracks([]captureplane.PulledCaptureTrack{identity}); err != nil {
		t.Fatal(err)
	}
	answer, err := peer.AnswerRemoteOffer(ctx, captureplane.Negotiation{ID: "ingress", Requirement: captureplane.NegotiationAnswerNeeded, Description: response.Description})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ingressRequest(ctx, http.MethodPut, "/sessions/"+created.SessionID+"/renegotiate", struct {
		Description captureplane.Description `json:"sessionDescription"`
	}{answer})
	if err != nil {
		t.Fatal(err)
	}
	remote, err := peer.WaitForTrack(ctx, mid)
	if err != nil {
		t.Fatal(err)
	}
	if remote.Codec() != "vp8" {
		t.Fatalf("expected VP8, got %s", remote.Codec())
	}
	var extensions []string
	var ridID, repairedRID uint8
	for _, line := range strings.Split(response.Description.SDP, "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			var id uint8
			if _, err := fmt.Sscanf(parts[0], "a=extmap:%d", &id); err == nil {
				if parts[1] == "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id" {
					ridID = id
				}
				if parts[1] == "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id" {
					repairedRID = id
				}
			}
		}
		if strings.HasPrefix(line, "a=extmap:") || strings.HasPrefix(line, "a=ssrc-group:") || strings.HasPrefix(line, "a=rtpmap:") || strings.HasPrefix(line, "a=fmtp:") {
			extensions = append(extensions, strings.TrimSpace(line))
		}
	}
	var answerExtensions []string
	for _, line := range strings.Split(answer.SDP, "\n") {
		if strings.HasPrefix(line, "a=extmap:") || strings.HasPrefix(line, "a=rtpmap:") || strings.HasPrefix(line, "a=fmtp:") || strings.HasPrefix(line, "a=rtcp-fb:") {
			answerExtensions = append(answerExtensions, strings.TrimSpace(line))
		}
	}
	metadata, err := json.Marshal(struct {
		Policy           *ingressPolicy `json:"policy"`
		RID              string         `json:"track_rid"`
		SDPHeaders       []string       `json:"sdp_headers"`
		AnswerExtensions []string       `json:"answer_extensions"`
	}{subscription.Simulcast, remote.RID(), extensions, answerExtensions})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(os.Getenv("INGRESS_OUTPUT"), policy+".metadata.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	track := &ingressObservedTrack{CaptureMediaTrack: remote, start: start, salt: salt, pending: make(map[*rtp.Packet]*ingressRow), ridID: ridID, repairedRID: repairedRID}
	defer func() {
		file, err := os.OpenFile(filepath.Join(os.Getenv("INGRESS_OUTPUT"), policy+".jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			t.Error(err)
			return
		}
		defer file.Close()
		encoder := json.NewEncoder(file)
		for _, row := range track.rows {
			if err := encoder.Encode(row); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	events := make(chan captureRuntimeEvent, 1024)
	stop, err := startCaptureReader(ctx, &capturePionPeer{peer}, string(mid), track, 250*time.Millisecond, 10*time.Second, events)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	output := os.Getenv("INGRESS_OUTPUT")
	if err := os.WriteFile(filepath.Join(output, policy+".ready"), []byte("ready\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var clock captureTrackClock
	timer := time.NewTimer(180 * time.Second)
	defer timer.Stop()
	consume := func(event captureRuntimeEvent) {
		if event.err != nil {
			t.Fatalf("capture reader: %v", event.err)
		}
		if event.packet == nil {
			return
		}
		track.mu.Lock()
		defer track.mu.Unlock()
		row := track.pending[event.packet]
		if row == nil {
			t.Fatal("production admission differs from shadow admission")
		}
		row.NegativeOffset = clock.started && int32(event.packet.Timestamp-clock.baseTS) < 0
		_, normalized := clock.normalize(event.packet, captureplane.TrackKindVideo, event.at.Sub(start).Milliseconds())
		row.NormalizedTimestamp = &normalized
		row.Admitted = true
		delete(track.pending, event.packet)
	}
collect:
	for {
		select {
		case event := <-events:
			consume(event)
		case <-timer.C:
			break collect
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	stop()
	for len(events) > 0 {
		consume(<-events)
	}
	// Cancellation can win sendCaptureRuntimeEvent for the final in-flight
	// packet. Preserve and label that boundary rather than losing the run.
	for _, row := range track.pending {
		if len(track.pending) != 1 || row != track.rows[len(track.rows)-1] {
			t.Fatalf("%d non-terminal pending admissions", len(track.pending))
		}
		row.Outcome = "measurement_boundary"
	}
	t.Logf("policy=%s packets=%d duration=180s", policy, len(track.rows))
}
