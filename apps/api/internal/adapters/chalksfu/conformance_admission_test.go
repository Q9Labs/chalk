package chalksfu_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

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
