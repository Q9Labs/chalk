package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
	cloudflaresfu "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	chalkpion "github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This opt-in qualification uses live SFU publishers and the production capture,
// decode and compositor implementations. Only control-plane persistence, object
// storage and one transient provider response are substituted. It never writes
// a recording to a production tenant or changes an existing recording.
func TestLiveRecordingAudioRecoversMissingPublication(t *testing.T) {
	if os.Getenv("CHALK_RUN_LIVE_RECORDING_AUDIO_PROOF") != "1" {
		t.Skip("live recording audio proof is not enabled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out, err := filepath.Abs(os.Getenv("CHALK_RECORDING_AUDIO_PROOF_DIR"))
	if err != nil || os.Getenv("CHALK_RECORDING_AUDIO_PROOF_DIR") == "" {
		t.Fatal("proof directory is required")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	tenant := captureTestID(t, os.Getenv("CHALK_RECORDING_AUDIO_FIXTURE_TENANT"))
	id := func() utilities.ID {
		value, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	space, episode, recording, jobID, claimID := id(), id(), id(), id(), id()
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	fault := &recordingAudioFaultClient{client: &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Protocols: protocols}}}
	adapter, err := cloudflaresfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: os.Getenv(config.CloudflareRealtimeAppID), RealtimeAppSecret: os.Getenv(config.CloudflareRealtimeAppSecret), RequestTimeout: 10 * time.Second,
	}, fault, "https://rtc.live.cloudflare.com/v1")
	if err != nil {
		t.Fatal(err)
	}
	ice := webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}}
	var tracks []captureplane.PulledCaptureTrack
	for index, name := range []string{"Speaker A", "Speaker B"} {
		track := recordingAudioPublisher(t, ctx, adapter, ice, episode.String(), name, filepath.Join(out, fmt.Sprintf("speaker-%d.ogg", index)))
		track.ParticipantID, track.ParticipantGeneration = id(), 1
		tracks = append(tracks, track)
	}
	fault.track = tracks[1].TrackReference.String()
	fault.owner = tracks[1].OwnerReference.String()
	now := time.Now().UTC()
	auth, err := recordingpipeline.NewRecorderJobAuthority(recordingpipeline.Job{ID: jobID, TenantID: tenant, EpisodeID: episode, RecordingID: recording, Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, AttemptLimit: 3, FencingGeneration: 1}, recordingpipeline.ClaimFacts{SpaceID: space, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: now.Add(5 * time.Minute), CaptureEpoch: 1}, claimID, now)
	if err != nil {
		t.Fatal(err)
	}
	claim := ClaimResult{ClaimRequestID: claimID, Envelope: auth.Envelope, EnvelopeDigest: auth.EnvelopeDigest, LeaseOwner: "audio-proof", LeaseToken: "local-proof-lease", LeaseExpiresAt: now.Add(5 * time.Minute)}
	plans := &recordingAudioPlans{tracks: tracks, start: now}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	factory, err := NewPionCaptureAttemptFactory(PionCaptureAttemptFactoryConfig{
		Signaling: &recordingAudioSignaling{adapter: adapter}, Plans: plans, Keys: storage, Objects: storage, Bundles: storage, Lifecycle: &captureTestLifecycle{},
		NewPeer: func(config chalkpion.Config) (CapturePeer, error) {
			config.Configuration = ice
			peer, err := chalkpion.NewPeer(config)
			return &capturePionPeer{Peer: peer}, err
		},
		Attempt: CaptureAttemptConfig{Environment: "recording-audio-proof", PlanWait: time.Second, InitialPlanWait: time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := factory.NewCaptureAttempt(ctx, claim)
	if err != nil {
		t.Fatal(err)
	}
	if err := attempt.Run(ctx); err != nil {
		snapshot, snapshotErr := attempt.(*PionCaptureAttempt).coordinator.Snapshot()
		t.Logf("capture failure: active=%d snapshot_error=%v", len(snapshot.Tracks), snapshotErr)
		t.Fatal(err)
	}
	fault.mu.Lock()
	injected := fault.injected
	fault.mu.Unlock()
	if injected != 1 {
		t.Fatalf("injected responses = %d, want 1", injected)
	}
	var files []recordingdecode.BundleFile
	var duration int64
	sources := map[string]recordingbundle.TrackIdentity{}
	counts := map[string]int{}
	for _, upload := range storage.uploadHistory {
		bundle, err := recordingbundle.Open(upload.Body, storage.key)
		if err != nil {
			t.Fatal(err)
		}
		m := bundle.Manifest
		path := filepath.Join(out, fmt.Sprintf("bundle-%d.bundle", m.Sequence))
		if err := os.WriteFile(path, upload.Body, 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(upload.Body)
		files = append(files, recordingdecode.BundleFile{Path: path, ExpectedSHA256: hex.EncodeToString(digest[:]), Sequence: m.Sequence, CaptureEpoch: 1, CaptureJobID: jobID.String(), RecorderEnvelopeDigest: m.RecorderEnvelopeDigest, BundleSchema: m.Encryption.BundleSchema, KeyHandle: auth.Envelope.KeyHandle})
		if m.MediaRange.EndMilliseconds > duration {
			duration = m.MediaRange.EndMilliseconds
		}
		for _, fragment := range bundle.Fragments {
			sources[fragment.Track.TrackID] = fragment.Track
			counts[fragment.Track.TrackID] += len(fragment.Packets)
		}
	}
	if len(sources) != 2 {
		t.Fatalf("captured %d sources, want two: %v", len(sources), counts)
	}
	duration += 100
	profile, err := recordingpresentation.NewComposite720PProfile()
	if err != nil {
		t.Fatal(err)
	}
	timeline := recordingpresentation.Timeline{SchemaVersion: recordingpresentation.SchemaVersion, RecordingID: recording.String(), EpisodeID: episode.String(), Clock: recordingpresentation.Clock{Origin: "capture_ready", Timebase: "recording_relative_ms", CaptureEpoch: 1, OriginAuthorityID: jobID.String(), DurationMillis: duration}, Initial: recordingpresentation.Snapshot{Profile: profile, Space: recordingpresentation.Space{ID: space.String(), Name: "Recording audio recovery proof"}, View: recordingpresentation.View{Layout: "grid", Sidebar: "chat"}, Participants: []recordingpresentation.Participant{}, Media: []recordingpresentation.MediaSource{}, Chat: recordingpresentation.Chat{Messages: []recordingpresentation.ChatMessage{}}, SharedContent: recordingpresentation.SharedContent{Kind: "none"}, Reactions: []recordingpresentation.Reaction{}}, Events: []recordingpresentation.Event{}, Assets: []recordingpresentation.Asset{}}
	// Bind presentation identities to the tracks actually authenticated in the bundles.
	for index, track := range tracks {
		var captured recordingbundle.TrackIdentity
		for _, source := range sources {
			if source.TrackID == track.TrackReference.String() {
				captured = source
			}
		}
		if captured.TrackID == "" {
			t.Fatalf("cannot bind speaker %d to captured track: %v", index, sources)
		}
		sourceID, err := recordingpresentation.SourceID(recordingpresentation.MediaSourceIdentity{RecordingID: recording.String(), ParticipantID: track.ParticipantID.String(), ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: captured.TrackID, Epoch: int64(captured.Epoch)})
		if err != nil {
			t.Fatal(err)
		}
		timeline.Initial.Participants = append(timeline.Initial.Participants, recordingpresentation.Participant{ID: track.ParticipantID.String(), DisplayName: fmt.Sprintf("Speaker %c", 'A'+index), JoinOrdinal: int64(index + 1), Joined: true})
		timeline.Initial.Media = append(timeline.Initial.Media, recordingpresentation.MediaSource{SourceID: sourceID, ParticipantID: track.ParticipantID.String(), ParticipantGeneration: 1, Kind: recordingpresentation.MediaKindMicrophone, TrackID: captured.TrackID, Epoch: int64(captured.Epoch), Visible: false})
		t.Logf("speaker=%c packets=%d epoch=%d", 'A'+index, counts[captured.TrackID], captured.Epoch)
	}
	presentation, err := recordingpresentation.Encode(timeline)
	if err != nil {
		t.Fatal(err)
	}
	presentationPath := filepath.Join(out, "presentation.json")
	if err := os.WriteFile(presentationPath, presentation, 0600); err != nil {
		t.Fatal(err)
	}
	decoded, err := recordingdecode.Write(ctx, recordingdecode.Request{RecordingID: recording.String(), EpisodeID: episode.String(), TenantID: tenant.String(), Environment: "recording-audio-proof", OriginAuthorityID: jobID.String(), CaptureEpoch: 1, DurationMS: duration, OutputDirectory: filepath.Join(out, "decoded"), FFmpegPath: "/usr/bin/ffmpeg", Presentation: timeline, Bundles: files, DataKeys: []recordingdecode.DataKey{{CaptureEpoch: 1, Plaintext: append([]byte(nil), storage.key...)}}, Runner: ExecCommandRunner{}})
	if err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(out, "assets")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	root := os.Getenv("CHALK_RECORDING_AUDIO_REPO")
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	producer := NodeComposeProducer{NodePath: node, ScriptPath: filepath.Join(root, "apps/recording-renderer/dist/node/compose.js"), FFmpegPath: "/usr/bin/ffmpeg", Encoder: EncoderLibX264, Threads: 2}
	digest := sha256.Sum256(presentation)
	result, err := producer.Compose(ctx, FrameRenderRequest{SchemaVersion: FrameRenderRequestVersion, RecordingID: recording.String(), EpisodeID: episode.String(), WorkspaceDirectory: out, PresentationPath: presentationPath, PresentationSHA256: hex.EncodeToString(digest[:]), AssetDirectory: assets, DecodedMediaPath: decoded.IndexPath, DecodedMediaSHA256: decoded.IndexSHA256, Width: 1280, Height: 720, FPS: 30, DurationMs: duration}, filepath.Join(out, "recording.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("injected_not_found=%d sources=%d duration_ms=%d frames=%d", injected, len(decoded.Index.Sources), duration, result.FrameCount)
}

type recordingAudioFaultClient struct {
	client   *http.Client
	mu       sync.Mutex
	track    string
	owner    string
	injected int
}

func (c *recordingAudioFaultClient) Do(request *http.Request) (*http.Response, error) {
	if strings.HasSuffix(request.URL.Path, "/tracks/new") && request.Body != nil {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		request.Body.Close()
		request.Body = io.NopCloser(bytes.NewReader(body))
		c.mu.Lock()
		if c.track != "" && c.injected == 0 && bytes.Contains(body, []byte(c.track)) && bytes.Contains(body, []byte(`"remote"`)) {
			c.injected++
			track := c.track
			c.mu.Unlock()
			encoded, _ := json.Marshal(map[string]any{"tracks": []any{map[string]any{"trackName": track, "sessionId": c.owner, "location": "remote", "errorCode": "not_found_track_error", "errorDescription": "Injected transient publication-not-forwardable window"}}})
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(encoded)), Request: request}, nil
		}
		c.mu.Unlock()
	}
	return c.client.Do(request)
}

type recordingAudioSignaling struct{ adapter cloudflaresfu.Adapter }

func (s *recordingAudioSignaling) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	c := request.Command
	result := capturesignaling.CommandResult{}
	var err error
	switch {
	case c.Input.CreateCaptureConnection != nil:
		value, e := s.adapter.CreateCaptureConnection(ctx, *c.Input.CreateCaptureConnection)
		result.CreateCaptureConnection = &value
		err = e
	case c.Input.PullCaptureTracks != nil:
		value, e := s.adapter.PullCaptureTracks(ctx, *c.Input.PullCaptureTracks)
		result.PullCaptureTracks = &value
		err = e
	case c.Input.RenegotiateCaptureConnection != nil:
		value, e := s.adapter.RenegotiateCaptureConnection(ctx, *c.Input.RenegotiateCaptureConnection)
		result.RenegotiateCaptureConnection = &value
		err = e
	case c.Input.CloseCaptureTracks != nil:
		value, e := s.adapter.CloseCaptureTracks(ctx, *c.Input.CloseCaptureTracks)
		result.CloseCaptureTracks = &value
		err = e
	case c.Input.CloseCaptureConnection != nil:
		value, e := s.adapter.CloseCaptureConnection(ctx, *c.Input.CloseCaptureConnection)
		result.CloseCaptureConnection = &value
		err = e
	default:
		err = fmt.Errorf("unexpected signaling command")
	}
	if err != nil {
		err = fmt.Errorf("live signaling %s: %w", c.Identity.Operation, err)
	}
	return capturesignaling.Execution{Key: capturesignaling.CommandKey{SignalingHandle: c.SignalingHandle, Operation: c.Identity.Operation, PlanRevision: c.Identity.PlanRevision, IdempotencyKey: c.Identity.IdempotencyKey}, Result: result}, err
}

type recordingAudioPlans struct {
	tracks []captureplane.PulledCaptureTrack
	start  time.Time
}

func (p *recordingAudioPlans) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	for {
		revision := captureplane.PlanRevision(1)
		tracks := p.tracks[:1]
		elapsed := time.Since(p.start)
		if elapsed >= 2*time.Second {
			revision = 2
			tracks = p.tracks
		}
		if elapsed >= 16*time.Second {
			return captureplan.Plan{}, capturesignaling.ErrMediaStopped
		}
		if revision > input.AfterRevision {
			participants := make([]captureplan.ParticipantSnapshot, 0, len(tracks))
			publications := make([]captureplan.TrackSnapshot, 0, len(tracks))
			for index, track := range tracks {
				participants = append(participants, captureplan.ParticipantSnapshot{ID: track.ParticipantID, Generation: 1, DisplayName: fmt.Sprintf("Speaker %c", 'A'+index), JoinOrdinal: int64(index + 1), Lifecycle: captureplan.ParticipantActive})
				publications = append(publications, captureplan.TrackSnapshot{ParticipantID: track.ParticipantID, ParticipantGeneration: 1, Source: track.Source, Kind: track.Kind, OwnerReference: track.OwnerReference, TrackReference: track.TrackReference, OwnerMID: track.MID, PublicationReference: captureplan.PublicationReference(track.TrackReference), RequestedLayer: captureplane.TrackLayerAuto})
			}
			return captureplan.NewPlan(captureplan.PlanInput{Authority: input.Authority(), Revision: revision, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS, EffectiveDeadline: p.start.Add(4 * time.Minute), StopState: captureplan.StopStateRunning, Participants: participants, Tracks: publications})
		}
		wait := input.MaxWait
		if wait > time.Second {
			wait = time.Second
		}
		select {
		case <-ctx.Done():
			return captureplan.Plan{}, ctx.Err()
		case <-time.After(wait):
		}
		if (time.Since(p.start) < 2*time.Second) || (input.AfterRevision >= 2 && time.Since(p.start) < 16*time.Second) {
			return captureplan.Plan{}, captureplan.ErrNoChange
		}
	}
}

func recordingAudioPublisher(t *testing.T, ctx context.Context, adapter cloudflaresfu.Adapter, ice webrtc.Configuration, episode, name, path string) captureplane.PulledCaptureTrack {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	reader, _, err := oggreader.NewWith(file)
	if err != nil {
		t.Fatal(err)
	}
	var packets [][]byte
	for {
		packet, _, err := reader.ParseNextPage()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.HasPrefix(packet, []byte("OpusTags")) {
			packets = append(packets, packet)
		}
	}
	file.Close()
	if len(packets) == 0 {
		t.Fatal("empty audio fixture")
	}
	pc, err := webrtc.NewPeerConnection(ice)
	if err != nil {
		t.Fatal(err)
	}
	mediaCtx, stop := context.WithCancel(ctx)
	t.Cleanup(func() {
		stop()
		if err := pc.Close(); err != nil {
			t.Error(err)
		}
	})
	trackName := fmt.Sprintf("proof-microphone-%d", time.Now().UnixNano())
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, trackName, "audio-proof")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	mid := ""
	for _, transceiver := range pc.GetTransceivers() {
		if transceiver.Sender() == sender {
			mid = transceiver.Mid()
		}
	}
	join, err := adapter.CreateJoin(ctx, mediaplane.CreateJoinInput{Provider: mediaplane.ProviderCloudflareSFU, Episode: mediaplane.Episode{Provider: mediaplane.ProviderCloudflareSFU, Ref: episode}, ParticipantName: name, ExternalParticipantID: name, ParticipantPreset: "recording-audio-proof"})
	if err != nil {
		t.Fatal(err)
	}
	connection := join.ClientPayload["connectionId"].(string)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := adapter.CloseTracks(cleanup, mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: connection, Tracks: []mediaplane.CloseTrack{{Mid: mid, Source: "microphone", PublicationID: trackName}}, Force: true})
		if err != nil {
			t.Error(err)
		}
	})
	local := pc.LocalDescription()
	result, err := adapter.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: connection, SessionDescription: &mediaplane.SessionDescription{Type: local.Type.String(), SDP: local.SDP}, Tracks: []mediaplane.Track{{Location: "local", Mid: mid, TrackName: trackName, Source: "microphone"}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionDescription == nil {
		t.Fatal("publisher answer missing")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: result.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		index := 0
		for {
			select {
			case <-mediaCtx.Done():
				return
			case <-ticker.C:
				if err := track.WriteSample(media.Sample{Data: packets[index%len(packets)], Duration: 20 * time.Millisecond}); err != nil {
					return
				}
				index++
			}
		}
	}()
	return captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto, OwnerReference: captureplane.ProviderReference(connection), TrackReference: captureplane.ProviderReference(trackName)}, MID: captureplane.ProviderReference(mid)}
}
