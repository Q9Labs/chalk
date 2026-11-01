package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// fakeIdleExpiryCloudflare models the Cloudflare behavior that strands listeners: a session whose
// first use comes 15 s or more after creation answers 410 session_error. A session used in time
// keeps working.
type fakeIdleExpiryCloudflare struct {
	mu       sync.Mutex
	clock    time.Duration
	created  map[string]time.Duration
	used     map[string]bool
	sessions []string
	requests []string
}

func newFakeIdleExpiryCloudflare() *fakeIdleExpiryCloudflare {
	return &fakeIdleExpiryCloudflare{created: map[string]time.Duration{}, used: map[string]bool{}}
}

func (f *fakeIdleExpiryCloudflare) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clock += d
}

func (f *fakeIdleExpiryCloudflare) sessionCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sessions)
}

func (f *fakeIdleExpiryCloudflare) requestLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func (f *fakeIdleExpiryCloudflare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	path := strings.TrimPrefix(r.URL.Path, "/apps/app")
	if path == "/sessions/new" {
		id := fmt.Sprintf("cf-%d", len(f.sessions)+1)
		f.sessions = append(f.sessions, id)
		f.created[id] = f.clock
		fmt.Fprintf(w, `{"sessionId":%q}`, id)
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "/sessions/"), "/")
	id := parts[0]
	f.requests = append(f.requests, r.Method+" "+path)
	createdAt, known := f.created[id]
	if !known {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"errorCode":"session_not_found"}`)
		return
	}
	if !f.used[id] && f.clock-createdAt >= 15*time.Second {
		w.WriteHeader(http.StatusGone)
		fmt.Fprint(w, `{"errorCode":"session_error","errorDescription":"Session appears to be disconnected. Please check if the PeerConnection is connected."}`)
		return
	}
	f.used[id] = true
	if len(parts) == 2 && parts[1] == "renegotiate" {
		fmt.Fprint(w, `{}`)
		return
	}
	var request tracksRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	response := addTracksResponse{}
	for index, track := range request.Tracks {
		result := addTrackResult{Location: track.Location, Mid: fmt.Sprint(index), TrackName: track.TrackName, SessionID: track.SessionID}
		response.Tracks = append(response.Tracks, result)
		if track.Location == "remote" {
			if _, live := f.created[track.SessionID]; !live {
				response.Tracks[index].ErrorCode = "track_not_found"
			}
			response.RequiresImmediateRenegotiation = true
		}
	}
	response.SessionDescription = &mediaplane.SessionDescription{Type: "answer", SDP: "v=0"}
	_ = json.NewEncoder(w).Encode(response)
}

func newExpiryAdapter(t *testing.T) (Adapter, *fakeIdleExpiryCloudflare) {
	t.Helper()
	fake := newFakeIdleExpiryCloudflare()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return adapter, fake
}

func joinParticipant(t *testing.T, adapter Adapter, name string) string {
	t.Helper()
	join, err := adapter.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU, Episode: mediaplane.Episode{Ref: "episode"}, ExternalParticipantID: name,
	})
	if err != nil {
		t.Fatal(err)
	}
	connectionID, ok := join.ClientPayload["connectionId"].(string)
	if !ok || connectionID == "" {
		t.Fatalf("join has no connection ID: %+v", join.ClientPayload)
	}
	return connectionID
}

func publishRequest(connectionID string) mediaplane.TracksRequest {
	return mediaplane.TracksRequest{
		ConnectionID:       connectionID,
		SessionDescription: &mediaplane.SessionDescription{Type: "offer", SDP: "v=0"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: "0", TrackName: "mic"}},
	}
}

func pullRequest(connectionID, publisherID string) mediaplane.TracksRequest {
	return mediaplane.TracksRequest{
		ConnectionID: connectionID,
		Tracks:       []mediaplane.Track{{Location: "remote", SessionID: publisherID, TrackName: "mic"}},
	}
}

func TestListenerFirstPullAfterIdleExpiryHealsOnAFreshSession(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.advance(20 * time.Second)

	response, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))
	if err != nil {
		t.Fatalf("first pull after 20 s idle: %v", err)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].SessionID != publisher {
		t.Fatalf("pull must still name the publisher's connection ID %q: %+v", publisher, response.Tracks)
	}
	sessionsBefore := fake.sessionCount()
	if err := adapter.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: listener, SessionDescription: mediaplane.SessionDescription{Type: "answer", SDP: "v=0"}}); err != nil {
		t.Fatalf("renegotiate after swap: %v", err)
	}
	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("second pull: %v", err)
	}
	if got := fake.sessionCount(); got != sessionsBefore {
		t.Fatalf("a healed connection must not swap again: sessions %d -> %d", sessionsBefore, got)
	}
}

func TestSpeakerFirstPublishAfterIdleExpiryHealsAndListenersStillFindIt(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	speaker := joinParticipant(t, adapter, "speaker")
	fake.advance(20 * time.Second)

	if _, err := adapter.AddTracks(context.Background(), publishRequest(speaker)); err != nil {
		t.Fatalf("first publish after 20 s idle: %v", err)
	}
	freshListener := joinParticipant(t, adapter, "fresh-listener")
	response, err := adapter.AddTracks(context.Background(), pullRequest(freshListener, speaker))
	if err != nil {
		t.Fatalf("pull of the swapped publisher: %v", err)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].SessionID != speaker || len(response.TrackErrors) != 0 {
		t.Fatalf("pull must return the publisher's connection ID %q without errors: %+v", speaker, response)
	}
	deadSessionCalls := 0
	for _, line := range fake.requestLog() {
		if strings.Contains(line, "/"+speaker+"/") {
			deadSessionCalls++
		}
	}
	if deadSessionCalls != 1 {
		t.Fatalf("the dead session %q may only see the one failed first call, saw %d", speaker, deadSessionCalls)
	}
}

func TestIdleExpiryIsOnlySweptForConnectionsThatNeverNegotiated(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatal(err)
	}
	connection := joinParticipant(t, adapter, "listener")
	if _, err := adapter.AddTracks(context.Background(), pullRequest(connection, publisher)); err != nil {
		t.Fatalf("first use in time: %v", err)
	}
	sessions := fake.sessionCount()
	fake.advance(time.Hour)
	// The fake only expires unused sessions, so force the dead state for a negotiated one.
	fake.mu.Lock()
	fake.used[connection] = false
	fake.mu.Unlock()
	if _, err := adapter.AddTracks(context.Background(), pullRequest(connection, publisher)); !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a connection that negotiated before must report not found, got %v", err)
	}
	if got := fake.sessionCount(); got != sessions {
		t.Fatalf("no replacement session for a negotiated connection: %d -> %d", sessions, got)
	}
}

func TestConnectionThisAdapterNeverIssuedIsNotSwapped(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	if _, err := adapter.AddTracks(context.Background(), pullRequest("cf-unknown", "nobody")); !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("unknown connection must report not found, got %v", err)
	}
	if got := fake.sessionCount(); got != 0 {
		t.Fatalf("no session may be created for a connection this adapter never issued: %d", got)
	}
}

func TestConcurrentFirstCallsOnAnExpiredConnectionShareOneReplacement(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatal(err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.advance(20 * time.Second)
	sessionsBefore := fake.sessionCount()

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent first pull: %v", err)
		}
	}
	if got := fake.sessionCount() - sessionsBefore; got != 1 {
		t.Fatalf("replacement sessions created = %d, want 1", got)
	}
}
