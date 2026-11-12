package chalksfu_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// everySpace is the staging allowlist: these tests run the own SFU for a Space without picking an ID.
var everySpace = func() spaces.ChalkSFUAllowlist {
	list, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		panic(err)
	}
	return list
}()

func scopeOf(episode, participant string) mediaplane.Scope {
	return mediaplane.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: participant, Generation: 1}
}

func join(t *testing.T, service mediaplane.Service, scope mediaplane.Scope) (string, mediaplane.Join) {
	t.Helper()
	joined, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scope,
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
		ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor",
	})
	if err != nil {
		t.Fatalf("join %s: %v", scope.ParticipantID, err)
	}
	connection, _ := joined.ClientPayload["connectionId"].(string)
	if connection == "" {
		t.Fatalf("join payload has no connection ID: %+v", joined.ClientPayload)
	}
	return connection, joined
}

// publish pushes one track from a fresh peer and returns the peer, its track and the SFU's answer.
func publish(t *testing.T, service mediaplane.Service, connection string, scope mediaplane.Scope, name, source string) (*peer, string, mediaplane.TracksResponse) {
	t.Helper()
	publisher := newPeer(t)
	track := publisher.addAudio(t, name)
	offer := publisher.offer(t)
	response, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: connection, Scope: scope, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, track), TrackName: name, Source: source}},
	})
	if err != nil {
		t.Fatalf("push %s: %v", name, err)
	}
	if len(response.TrackErrors) == 0 {
		publisher.accept(t, response.SessionDescription)
		media, stop := context.WithCancel(context.Background())
		t.Cleanup(stop)
		send(media, track)
	}
	return publisher, publisher.mid(t, track), response
}

func TestConformanceSignaling(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	service := box.service(t)
	ctx := context.Background()
	alice, bob := scopeOf("ep-signal", "alice"), scopeOf("ep-signal", "bob")
	box.grant(t, alice)

	aliceConn, joined := join(t, service, alice)
	capabilities, _ := joined.ClientPayload["capabilities"].(map[string]any)
	if joined.ClientPayload["provider"] != "chalk_sfu" || capabilities["serverLayerAdaptation"] != true || capabilities["subscriptionState"] != true || capabilities["iceRestart"] != true || capabilities["pullPublished"] != true || capabilities["muteInPlace"] != true {
		t.Fatalf("join payload advertises the wrong provider or capabilities: %+v", joined.ClientPayload)
	}
	bobConn, _ := join(t, service, bob)

	t.Run("resume returns the same connection and a gone one is not found", func(t *testing.T) {
		resumed, err := service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: alice, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: alice.EpisodeID},
			ExternalParticipantID: "alice", ConnectionRef: aliceConn,
		})
		if err != nil || resumed.ClientPayload["connectionId"] != aliceConn {
			t.Fatalf("resume = %+v, %v", resumed, err)
		}
		_, err = service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: alice, Episode: mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: alice.EpisodeID},
			ExternalParticipantID: "alice", ConnectionRef: "no-such-session",
		})
		if !errors.Is(err, mediaplane.ErrConnectionNotFound) {
			t.Fatalf("resume of a gone session: %v", err)
		}
	})

	publisher := newPeer(t)
	audio := publisher.addAudio(t, "alice-mic")
	offer := publisher.offer(t)
	pushed, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: aliceConn, Scope: alice, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, audio), TrackName: "alice-mic", Source: "microphone"}},
	})
	if err != nil || len(pushed.Tracks) != 1 || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push = %+v, %v", pushed, err)
	}
	publisher.accept(t, pushed.SessionDescription)
	media, stop := context.WithCancel(ctx)
	defer stop()
	send(media, audio)
	aliceMid := publisher.mid(t, audio)

	subscriber := newPeer(t)
	pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"},
			{Location: "remote", SessionID: aliceConn, TrackName: "alice-missing"},
		},
	})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	t.Run("a pull mixes a success and an error", func(t *testing.T) {
		if len(pulled.Tracks) != 1 || pulled.Tracks[0].TrackName != "alice-mic" || pulled.Tracks[0].SessionID != aliceConn {
			t.Fatalf("pull = %+v", pulled)
		}
		// The error names the publisher's connection, which is what the client asked for,
		// and marks the publication missing so the API can retire it.
		if len(pulled.TrackErrors) != 1 || pulled.TrackErrors[0].TrackName != "alice-missing" || pulled.TrackErrors[0].Code != "track_not_found" || pulled.TrackErrors[0].ConnectionID != aliceConn || !pulled.TrackErrors[0].PublicationMissing {
			t.Fatalf("pull = %+v", pulled)
		}
		if !pulled.RequiresImmediateRenegotiation || pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" {
			t.Fatalf("pull does not ask the client to answer: %+v", pulled)
		}
	})
	if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	eventually(t, "media to reach the subscriber", 20*time.Second, func() bool { return subscriber.received.Load() >= 20 })
	bobMid := pulled.Tracks[0].Mid

	t.Run("a layer update changes no SDP", func(t *testing.T) {
		updated, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{
			ConnectionID: bobConn, Scope: bob,
			Tracks: []mediaplane.Track{{Location: "remote", Mid: bobMid, TrackName: "alice-mic", SessionID: aliceConn, Simulcast: &mediaplane.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}}},
		})
		if err != nil || updated.RequiresImmediateRenegotiation || updated.SessionDescription != nil || len(updated.TrackErrors) != 0 {
			t.Fatalf("layer update = %+v, %v", updated, err)
		}
	})

	t.Run("a pause in place stops delivery, keeps the MID and reports its state", func(t *testing.T) {
		paused, resumed := true, false
		subscription := mediaplane.Track{Location: "remote", Mid: bobMid, TrackName: "alice-mic", SessionID: aliceConn}
		read := func() mediaplane.SubscriptionState {
			t.Helper()
			states, err := service.SubscriptionStates(ctx, mediaplane.SubscriptionStatesRequest{ConnectionID: bobConn, Scope: bob})
			if err != nil || len(states) != 1 || states[0].Mid != bobMid || states[0].SessionID != aliceConn || states[0].TrackName != "alice-mic" {
				t.Fatalf("subscription states = %+v, %v", states, err)
			}
			return states[0]
		}
		before := read()
		if before.State != mediaplane.SubscriptionActive || before.Reason != "" {
			t.Fatalf("flowing subscription = %+v", before)
		}
		subscription.Paused = &paused
		updated, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{ConnectionID: bobConn, Scope: bob, Tracks: []mediaplane.Track{subscription}})
		if err != nil || updated.RequiresImmediateRenegotiation || updated.SessionDescription != nil || len(updated.TrackErrors) != 0 {
			t.Fatalf("pause = %+v, %v", updated, err)
		}
		during := read()
		if during.State != mediaplane.SubscriptionPaused || during.Reason != mediaplane.PauseViewer || during.Revision <= before.Revision {
			t.Fatalf("paused subscription = %+v after %+v", during, before)
		}
		held := subscriber.received.Load()
		time.Sleep(300 * time.Millisecond)
		if delivered := subscriber.received.Load() - held; delivered > 2 {
			t.Fatalf("a paused subscription still delivered %d packets", delivered)
		}
		subscription.Paused = &resumed
		if _, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{ConnectionID: bobConn, Scope: bob, Tracks: []mediaplane.Track{subscription}}); err != nil {
			t.Fatalf("resume: %v", err)
		}
		if after := read(); after.State != mediaplane.SubscriptionActive || after.Revision <= during.Revision {
			t.Fatalf("resumed subscription = %+v", after)
		}
		eventually(t, "media to resume", 10*time.Second, func() bool { return subscriber.received.Load() >= held+20 })
	})

	t.Run("a hold of a publication the node does not hold is a track error with no SDP", func(t *testing.T) {
		paused := true
		held, err := service.UpdateTracks(ctx, mediaplane.UpdateTracksRequest{
			ConnectionID: aliceConn, Scope: alice,
			Tracks: []mediaplane.Track{{Location: "local", Mid: "99", TrackName: "alice-mic", Source: "microphone", Paused: &paused}},
		})
		if err != nil || held.SessionDescription != nil || held.RequiresImmediateRenegotiation || len(held.TrackErrors) != 1 || held.TrackErrors[0].Code != "track_not_found" {
			t.Fatalf("hold of a missing publication = %+v, %v", held, err)
		}
	})

	t.Run("inspect sees own and peer sessions and a gone one as absent", func(t *testing.T) {
		own, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if err != nil || !own.Found || len(own.Tracks) != 1 || !own.Tracks[0].Active {
			t.Fatalf("own inspect = %+v, %v", own, err)
		}
		peerView, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: bob, Peer: true})
		if err != nil || !peerView.Found || len(peerView.Tracks) != 1 {
			t.Fatalf("peer inspect = %+v, %v", peerView, err)
		}
		absent, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: "no-such-session", Scope: alice})
		if err != nil || absent.Found {
			t.Fatalf("gone inspect = %+v, %v", absent, err)
		}
	})

	t.Run("receive-only close never stops a publication", func(t *testing.T) {
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, ReceiveOnly: true,
			Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
		})
		if err != nil || !closed.AlreadyClosed {
			t.Fatalf("receive-only close = %+v, %v", closed, err)
		}
		state, _ := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if len(state.Tracks) != 1 {
			t.Fatalf("the publication was stopped: %+v", state)
		}
	})

	t.Run("a negotiated close answers the client's offer", func(t *testing.T) {
		for _, transceiver := range subscriber.pc.GetTransceivers() {
			if err := transceiver.Stop(); err != nil {
				t.Fatal(err)
			}
		}
		closeOffer := subscriber.offer(t)
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: bobConn, Scope: bob,
			Tracks: []mediaplane.CloseTrack{{Mid: bobMid, Source: "microphone", PublicationID: "pub-bob"}}, SessionDescription: &closeOffer,
		})
		if err != nil || closed.SessionDescription == nil || closed.AlreadyClosed {
			t.Fatalf("negotiated close = %+v, %v", closed, err)
		}
		subscriber.accept(t, closed.SessionDescription)
	})

	t.Run("a forced close stops the publication and repeats safely", func(t *testing.T) {
		for attempt := 0; attempt < 2; attempt++ {
			if _, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
				Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, Force: true,
				Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
			}); err != nil {
				t.Fatalf("forced close attempt %d: %v", attempt, err)
			}
		}
		state, _ := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
		if len(state.Tracks) != 0 {
			t.Fatalf("tracks after forced close: %+v", state.Tracks)
		}
	})

	t.Run("ending the Episode removes its sessions and usage stays empty", func(t *testing.T) {
		if err := service.EndEpisode(ctx, mediaplane.EndEpisodeInput{Provider: mediaplane.ProviderChalkSFU, TenantID: "tenant-1", EpisodeRef: "ep-signal"}); err != nil {
			t.Fatalf("end Episode: %v", err)
		}
		for _, connection := range []struct {
			id    string
			scope mediaplane.Scope
		}{{aliceConn, alice}, {bobConn, bob}} {
			state, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: connection.id, Scope: connection.scope})
			if err != nil || state.Found {
				t.Fatalf("session %s after the Episode ended: %+v, %v", connection.id, state, err)
			}
		}
		closed, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: mediaplane.ProviderChalkSFU, ConnectionID: aliceConn, Scope: alice, Force: true, Tracks: []mediaplane.CloseTrack{{Mid: aliceMid, Source: "microphone", PublicationID: "pub-alice"}},
		})
		if err != nil || !closed.AlreadyClosed {
			t.Fatalf("forced close of a gone session = %+v, %v", closed, err)
		}
		usage, err := service.EpisodeUsage(ctx, mediaplane.EpisodeUsageInput{Provider: mediaplane.ProviderChalkSFU, EpisodeRef: "ep-signal"})
		if err != nil || usage.ParticipantMinutes != 0 || usage.EgressBytes != 0 || usage.IngressBytes != 0 {
			t.Fatalf("usage = %+v, %v", usage, err)
		}
	})
}

func TestConformanceOneScreenSharePerEpisode(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	service := box.service(t)
	alice, bob := scopeOf("ep-screen", "alice"), scopeOf("ep-screen", "bob")
	aliceConn, _ := join(t, service, alice)
	bobConn, _ := join(t, service, bob)

	_, _, first := publish(t, service, aliceConn, alice, "alice-screen", "screen")
	if len(first.Tracks) != 1 {
		t.Fatalf("first screen share = %+v", first)
	}
	_, _, second := publish(t, service, bobConn, bob, "bob-screen", "screen")
	if len(second.Tracks) != 0 || len(second.TrackErrors) != 1 || second.TrackErrors[0].Code != "screen_share_active" {
		t.Fatalf("second screen share = %+v, want screen_share_active", second)
	}
}

func TestConformanceAdmission(t *testing.T) {
	t.Run("on the default budget an Episode reserves at most its ceiling", func(t *testing.T) {
		// 150 + 50 packets/s per stream pair: 9 Participants would reserve 18,000 nominally,
		// but an Episode reserves at most its 11,520 ceiling, which the 16,000 budget holds.
		service := startSFU(t, nil).service(t)
		for index := 0; index < 9; index++ {
			join(t, service, scopeOf("ep-full", "p"+strconv.Itoa(index)))
		}
	})

	t.Run("the Participant cap stays configurable", func(t *testing.T) {
		service := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "1000000", "SFU_MAX_EPISODE_PARTICIPANTS": "3"}).service(t)
		for index := 0; index < 3; index++ {
			join(t, service, scopeOf("ep-capped", "p"+strconv.Itoa(index)))
		}
		_, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-capped", "p3"),
			Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-capped"},
			ParticipantName: "p3", ParticipantPreset: "contributor",
		})
		if !errors.Is(err, mediaplane.ErrProviderRateLimited) {
			t.Fatalf("fourth join error = %v, want a capacity refusal", err)
		}
		join(t, service, scopeOf("ep-other", "p0"))
	})

	t.Run("a join that exceeds the packet budget is refused", func(t *testing.T) {
		// One stream pair costs 150 packets/s: two Participants reserve 900, three reserve 1,800.
		service := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "1000", "SFU_CAMERA_UPLINK_COST": "100", "SFU_VIDEO_STREAM_COST": "100", "SFU_SCREEN_STREAM_COST": "100", "SFU_AUDIO_STREAM_COST": "50"}).service(t)
		join(t, service, scopeOf("ep-budget", "alice"))
		join(t, service, scopeOf("ep-budget", "bob"))
		// The Episode's 1,000 ceiling equals the budget, so a third Participant still fits it,
		// and a second Episode's 900 does not.
		join(t, service, scopeOf("ep-budget", "carol"))
		_, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-second", "dave"),
			Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-second"},
			ParticipantName: "dave", ParticipantPreset: "contributor",
		})
		if !errors.Is(err, mediaplane.ErrProviderRateLimited) {
			t.Fatalf("over-budget join error = %v, want a capacity refusal", err)
		}
	})
}

func TestConformanceTransportIdentity(t *testing.T) {
	box := startSFU(t, nil)
	input := mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-auth", "alice"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-auth"},
		ParticipantName: "alice", ParticipantPreset: "contributor",
	}

	t.Run("a certificate from another CA cannot connect", func(t *testing.T) {
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, box.adapter(t, newAuthority(t, "rogue CA"), clientIdentity))
		if _, err := service.CreateJoin(context.Background(), input); !errors.Is(err, mediaplane.ErrProviderFailed) {
			t.Fatalf("rogue CA error = %v", err)
		}
	})

	t.Run("the right CA with the wrong identity is forbidden", func(t *testing.T) {
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, box.adapter(t, box.ca, "someone-else.test"))
		if _, err := service.CreateJoin(context.Background(), input); !errors.Is(err, mediaplane.ErrProviderUnauthorized) {
			t.Fatalf("wrong identity error = %v, want unauthorized", err)
		}
	})

	t.Run("neither attempt created a session", func(t *testing.T) {
		state, err := box.service(t).InspectSession(context.Background(), mediaplane.InspectSessionRequest{ConnectionID: "x", Scope: input.Scope})
		if err != nil || state.Found {
			t.Fatalf("inspect = %+v, %v", state, err)
		}
	})
}

// A retried push must run once. The proxy forwards the first push to the SFU,
// drops the answer and returns 502, so the adapter retries with the same
// operation ID and the SFU replays the first result.
func TestConformanceRetriedPushRunsOnce(t *testing.T) {
	box := startSFU(t, nil)
	direct := box.service(t)
	alice := scopeOf("ep-retry", "alice")
	aliceConn, _ := join(t, direct, alice)

	upstream := box.httpClient(t, box.ca, clientIdentity)
	var pushes atomic.Int32
	proxy := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		forward, _ := http.NewRequestWithContext(r.Context(), r.Method, box.controlURL+r.URL.Path, bytes.NewReader(body))
		forward.Header.Set("Content-Type", "application/json")
		reply, err := upstream.Do(forward)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer reply.Body.Close()
		payload, _ := io.ReadAll(reply.Body)
		if strings.HasSuffix(r.URL.Path, "/tracks") && pushes.Add(1) == 1 {
			http.Error(w, "answer lost", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.StatusCode)
		_, _ = w.Write(payload)
	}))
	certPEM, keyPEM := box.ca.issue(t, "localhost", 1)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	proxy.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	proxy.StartTLS()
	t.Cleanup(proxy.Close)

	retrying := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, box.adapterAt(t, proxy.URL))
	publisher := newPeer(t)
	audio := publisher.addAudio(t, "alice-mic")
	offer := publisher.offer(t)
	response, err := retrying.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: aliceConn, Scope: alice, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, audio), TrackName: "alice-mic", Source: "microphone"}},
	})
	if err != nil || len(response.Tracks) != 1 || len(response.TrackErrors) != 0 {
		t.Fatalf("retried push = %+v, %v", response, err)
	}
	publisher.accept(t, response.SessionDescription)
	if pushes.Load() != 2 {
		t.Fatalf("push reached the proxy %d times, want 2 (one lost, one retried)", pushes.Load())
	}
	state, _ := direct.InspectSession(context.Background(), mediaplane.InspectSessionRequest{ConnectionID: aliceConn, Scope: alice})
	if len(state.Tracks) != 1 {
		t.Fatalf("tracks after a retried push = %+v, want exactly one", state.Tracks)
	}
}

type episodeBindings struct{ binding *mediaplane.Binding }

func (e episodeBindings) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": e.binding})
	if err != nil {
		return episodes.Episode{}, err
	}
	return episodes.Episode{ConfigSnapshot: snapshot}, nil
}

// Flipping a Space's selector during a call leaves the live Episode on the
// provider it started with; only the next Episode takes the new selection.
func TestConformanceSelectionFlipPinsLiveEpisodes(t *testing.T) {
	box := startSFU(t, nil)
	adapter := box.fleet(t)
	adapter.Probe(context.Background())
	process := runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	cloudflareSpace := spaces.Space{MediaPlane: mediaplane.ProviderCloudflareSFU.SettingName()}
	registry := func(live *mediaplane.Binding) mediaplaneproviders.Registry {
		return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
			ProcessConfig: process, DefaultProvider: mediaplane.ProviderCloudflareSFU, ChalkSFU: adapter, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace}, Episodes: episodeBindings{live},
		})
	}

	started, err := registry(nil).ResolveBinding(context.Background(), tenants.Tenant{}, cloudflareSpace, mediaplane.ClientProviders{})
	if err != nil || started.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("Episode started under Cloudflare: %+v, %v", started, err)
	}
	live, err := registry(started).ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("live Episode after the flip: %v, %v", live, err)
	}

	oldSDK, err := registry(started).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, mediaplane.ClientProviders{})
	if err != nil || oldSDK.Provider != mediaplane.ProviderCloudflareSFU.SettingName() {
		t.Fatalf("an SDK that cannot run the own SFU got %+v, %v, want Cloudflare", oldSDK, err)
	}
	next, err := registry(started).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu"))
	if err != nil || next.Provider != mediaplane.ProviderChalkSFU.SettingName() || next.Node != "sfu-a" {
		t.Fatalf("next Episode binding: %+v, %v, want chalk_sfu on sfu-a", next, err)
	}
	if started.Node != "" {
		t.Fatalf("a Cloudflare binding names node %q", started.Node)
	}
	moved := *next
	moved.Node = "sfu-gone"
	if _, err := registry(&moved).ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSpace, utilities.ID{}); err == nil {
		t.Fatal("an Episode bound to a node this process lacks resolved to another node")
	}
	service, err := registry(next).ResolveEpisode(context.Background(), tenants.Tenant{}, cloudflareSpace, utilities.ID{})
	if err != nil || service.Provider() != mediaplane.ProviderChalkSFU {
		t.Fatalf("next Episode after flipping back: %v, %v", service, err)
	}
}

// An operator's change after an Episode started never moves it: flipping the Space
// setting, the Tenant default or the kill switch changes only the next Episode, and a
// live own-SFU Episode keeps resolving to the node it was bound to.
func TestConformanceSettingFlipsNeverMoveALiveEpisode(t *testing.T) {
	box := startSFU(t, nil)
	adapter := box.fleet(t)
	adapter.Probe(context.Background())
	process := runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}
	own, cloudflare := mediaplane.ProviderChalkSFU, mediaplane.ProviderCloudflareSFU
	ownText, cloudflareText := string(own), string(cloudflare)
	registry := func(live *mediaplane.Binding, paused bool) mediaplaneproviders.Registry {
		return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
			ProcessConfig: process, DefaultProvider: cloudflare, ChalkSFU: adapter, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace, NewEpisodesPaused: paused},
			Episodes: episodeBindings{live},
		})
	}
	ownSpace := spaces.Space{MediaPlane: ownText, MediaPlaneSetting: &own}

	started, err := registry(nil, false).ResolveBinding(context.Background(), tenants.Tenant{}, ownSpace, ownSFUClients)
	if err != nil || started.Provider != ownText || started.Node != "sfu-a" {
		t.Fatalf("Episode started on the own SFU: %+v, %v", started, err)
	}

	flips := []struct {
		name   string
		tenant tenants.Tenant
		space  spaces.Space
		paused bool
	}{
		{"Space set to Cloudflare", tenants.Tenant{}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, false},
		{"Space cleared, Tenant on Cloudflare", tenants.Tenant{DefaultMediaPlane: &cloudflareText}, spaces.Space{MediaPlane: cloudflareText}, false},
		{"kill switch on", tenants.Tenant{}, ownSpace, true},
		{"everything flipped at once", tenants.Tenant{DefaultMediaPlane: &cloudflareText}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, true},
	}
	for _, flip := range flips {
		live, err := registry(started, flip.paused).ResolveEpisode(context.Background(), flip.tenant, flip.space, utilities.ID{})
		if err != nil || live.Provider() != mediaplane.ProviderChalkSFU {
			t.Errorf("%s: the live own-SFU Episode resolved to %v, %v", flip.name, live, err)
			continue
		}
		next, err := registry(started, flip.paused).ResolveBinding(context.Background(), flip.tenant, flip.space, ownSFUClients)
		if err != nil || next.Provider != cloudflareText {
			t.Errorf("%s: the next Episode got %+v, %v, want Cloudflare", flip.name, next, err)
		}
	}

	// The reverse: a Cloudflare Episode stays on Cloudflare after the Space is set to the own SFU.
	onCloudflare, err := registry(nil, false).ResolveBinding(context.Background(), tenants.Tenant{}, spaces.Space{MediaPlane: cloudflareText, MediaPlaneSetting: &cloudflare}, ownSFUClients)
	if err != nil || onCloudflare.Provider != cloudflareText {
		t.Fatalf("Episode started on Cloudflare: %+v, %v", onCloudflare, err)
	}
	live, err := registry(onCloudflare, false).ResolveEpisode(context.Background(), tenants.Tenant{}, ownSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderCloudflareSFU {
		t.Fatalf("live Cloudflare Episode after the Space moved to the own SFU: %v, %v", live, err)
	}
}

// A Tenant whose Chalk-managed document names Cloudflare still lets a Space pick
// the own SFU, because Chalk runs both providers in that mode.
func TestConformanceChalkManagedTenantLetsTheSpacePickTheOwnSFU(t *testing.T) {
	box := startSFU(t, nil)
	fleet := box.fleet(t)
	fleet.Probe(context.Background())
	registry := mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig:   runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second},
		DefaultProvider: mediaplane.ProviderCloudflareSFU, ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace},
	})
	tenant := tenants.Tenant{MediaPlaneProviderConfig: json.RawMessage(`{"provider":"cf_sfu","mode":"chalk_managed"}`)}
	binding, err := registry.ResolveBinding(context.Background(), tenant, spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}, ownSFUClients)
	if err != nil || binding == nil || binding.Provider != mediaplane.ProviderChalkSFU.SettingName() {
		t.Fatalf("binding = %+v, err = %v, want chalk_sfu", binding, err)
	}
}

// Against the real SFU binary: a subscription to a source without a live grant reads
// paused with source_unauthorized, and the read still reports the granted one.
func TestSubscriptionStatesReportAnUngrantedSource(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	service := box.service(t)
	ctx := context.Background()
	alice, carol, bob := scopeOf("ep-unauthorized", "alice"), scopeOf("ep-unauthorized", "carol"), scopeOf("ep-unauthorized", "bob")
	box.grant(t, alice)
	aliceConn, _ := join(t, service, alice)
	carolConn, _ := join(t, service, carol)
	bobConn, _ := join(t, service, bob)
	publish(t, service, aliceConn, alice, "alice-mic", "microphone")
	publish(t, service, carolConn, carol, "carol-mic", "microphone")
	subscriber := newPeer(t)
	pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"}, {Location: "remote", SessionID: carolConn, TrackName: "carol-mic"}},
	})
	if err != nil || len(pulled.Tracks) != 2 {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}
	if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}

	states, err := service.SubscriptionStates(ctx, mediaplane.SubscriptionStatesRequest{ConnectionID: bobConn, Scope: bob})
	if err != nil {
		t.Fatalf("an ungranted source must not fail the whole read: %v", err)
	}
	reasons := map[string]string{}
	for _, state := range states {
		reasons[state.TrackName] = state.State + "/" + state.Reason
	}
	unauthorized := mediaplane.SubscriptionPaused + "/" + mediaplane.PauseSourceUnauthorized
	if len(states) != 2 || reasons["carol-mic"] != unauthorized || reasons["alice-mic"] == unauthorized {
		t.Fatalf("subscription states = %+v", states)
	}
}

// cancelingRelay gives up the join while TURN credentials are being minted.
type cancelingRelay struct{ cancel context.CancelFunc }

func (c cancelingRelay) RelayServers(ctx context.Context) ([]mediaplane.ICEServer, error) {
	c.cancel()
	return nil, ctx.Err()
}

type fakeRelay struct{ err error }

func (f fakeRelay) RelayServers(context.Context) ([]mediaplane.ICEServer, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []mediaplane.ICEServer{{URLs: []string{"turns:turn.example:443?transport=tcp"}, Username: "u", Credential: "c"}}, nil
}

// The SFU has no TCP media, so a client limited to TCP 443 needs TURN. Only
// joins the caller allows to relay get it, and a TURN failure leaves STUN.
func TestConformanceRelayOnlyForAllowedJoins(t *testing.T) {
	s := startSFU(t, nil)
	iceServers := func(adapter *chalksfu.Adapter, scope mediaplane.Scope, allow bool) []mediaplane.ICEServer {
		t.Helper()
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, adapter)
		joined, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: scope,
			Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
			ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor",
			AllowRelay: allow,
		})
		if err != nil {
			t.Fatalf("join %s: %v", scope.ParticipantID, err)
		}
		servers, _ := joined.ClientPayload["iceServers"].([]mediaplane.ICEServer)
		return servers
	}
	relayed := func(adapter *chalksfu.Adapter, scope mediaplane.Scope, allow bool) bool {
		t.Helper()
		for _, server := range iceServers(adapter, scope, allow) {
			for _, u := range server.URLs {
				if strings.HasPrefix(u, "turns:") {
					return true
				}
			}
		}
		return false
	}
	reader := turnMetricsReader()
	failuresBefore := turnMintFailureCount(t, reader)
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	plain := s.adapter(t, s.ca, clientIdentity)
	withRelay := plain.WithRelay(fakeRelay{})
	if !relayed(withRelay, scopeOf("ep-relay", "allowed"), true) {
		t.Fatal("an allowed join got no TURN server")
	}
	if relayed(withRelay, scopeOf("ep-relay", "denied"), false) {
		t.Fatal("a join that may not relay got a TURN server")
	}
	failing := plain.WithRelay(fakeRelay{err: errors.New("mint failed")})
	fallback := iceServers(failing, scopeOf("ep-relay-fallback", "fallback"), true)
	if len(fallback) == 0 || relayed(failing, scopeOf("ep-relay-fallback", "again"), true) {
		t.Fatalf("a failed mint must leave STUN servers and no TURN server, got %+v", fallback)
	}
	if !strings.Contains(logs.String(), `"event":"chalk_sfu.turn_credentials_failed"`) ||
		!strings.Contains(logs.String(), `"episode_id":"ep-relay-fallback"`) {
		t.Fatalf("mint failure log lacks the event or the Episode id: %s", logs.String())
	}
	if got := turnMintFailureCount(t, reader) - failuresBefore; got != 2 {
		t.Fatalf("turn mint failures = %d, want 2 (one per failed join)", got)
	}
	canceled, cancel := context.WithCancel(context.Background())
	defer cancel()
	abandoned := plain.WithRelay(cancelingRelay{cancel: cancel})
	if _, err := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, abandoned).CreateJoin(canceled, mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-relay-canceled", "canceled"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-relay-canceled"},
		ParticipantName: "canceled", ExternalParticipantID: "canceled", ParticipantPreset: "contributor", AllowRelay: true,
	}); err != nil {
		t.Fatalf("a join abandoned during the TURN mint: %v", err)
	}
	if got := turnMintFailureCount(t, reader) - failuresBefore; got != 2 {
		t.Fatalf("a canceled join counted as a mint failure: %d", got)
	}
}

// The adapter's package-level counter binds to the first global meter provider only,
// so every run in the process shares one reader and tests compare counts by difference.
var turnMetricsReader = sync.OnceValue(func() sdkmetric.Reader {
	reader := sdkmetric.NewManualReader()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))
	return reader
})

func turnMintFailureCount(t *testing.T, reader sdkmetric.Reader) int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "chalk.sfu.turn_mint_failures" {
				continue
			}
			for _, point := range m.Data.(metricdata.Sum[int64]).DataPoints {
				if got, _ := point.Attributes.Value("chalk.media_plane.provider"); got.AsString() != "chalk_sfu" || point.Attributes.Len() != 1 {
					t.Fatalf("counter attributes = %v, want only the media plane", point.Attributes)
				}
				total += point.Value
			}
		}
	}
	return total
}
