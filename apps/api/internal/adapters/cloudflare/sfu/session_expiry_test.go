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

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// fakeIdleExpiryCloudflare models the Cloudflare behavior that strands listeners: a session whose
// first use comes 15 s or more after creation answers 410 session_error. A session used in time
// keeps working.
type fakeIdleExpiryCloudflare struct {
	appID    string
	mu       sync.Mutex
	clock    time.Duration
	created  map[string]time.Duration
	used     map[string]bool
	sessions []string
	requests []string
	// expireAll answers 410 on the first use of every session, however young.
	expireAll bool
	// newSessionStatus, when set, is the HTTP status of every /sessions/new call.
	newSessionStatus int
}

func newFakeIdleExpiryCloudflare(appID string) *fakeIdleExpiryCloudflare {
	return &fakeIdleExpiryCloudflare{appID: appID, created: map[string]time.Duration{}, used: map[string]bool{}}
}

func (f *fakeIdleExpiryCloudflare) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clock += d
}

func (f *fakeIdleExpiryCloudflare) setExpireAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.expireAll = true
}

func (f *fakeIdleExpiryCloudflare) failNewSessions(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.newSessionStatus = status
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
	path := strings.TrimPrefix(r.URL.Path, "/apps/"+f.appID)
	if path == "/sessions/new" {
		if f.newSessionStatus != 0 {
			w.WriteHeader(f.newSessionStatus)
			fmt.Fprint(w, `{"errorCode":"rate_limited"}`)
			return
		}
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
	if !f.used[id] && (f.expireAll || f.clock-createdAt >= 15*time.Second) {
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

// newExpiryAdapter returns a new adapter for the test's own Cloudflare app. Adapters for one app share
// their session registry, as the provider registry builds a new adapter on every request.
func newExpiryAdapter(t *testing.T) (Adapter, *fakeIdleExpiryCloudflare) {
	t.Helper()
	appID := strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	fake := newFakeIdleExpiryCloudflare(appID)
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return newAdapterForFake(t, appID, server), fake
}

func newAdapterForFake(t *testing.T, appID string, server *httptest.Server) Adapter {
	t.Helper()
	adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: appID, RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
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

func TestExpiredReplacementSessionIsNotSwappedASecondTime(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatal(err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.setExpireAll()
	sessionsBefore, requestsBefore := fake.sessionCount(), len(fake.requestLog())

	_, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))

	if !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a replacement that is also gone must report not found, got %v", err)
	}
	if got := fake.sessionCount() - sessionsBefore; got != 1 {
		t.Fatalf("replacement sessions created = %d, want 1", got)
	}
	if got := len(fake.requestLog()) - requestsBefore; got != 2 {
		t.Fatalf("tracks/new requests = %d, want 2 (the first call and one retry)", got)
	}
}

func TestAdaptersForTheSameAppShareTheirIdleSessionRegistry(t *testing.T) {
	appID := "shared-app-" + t.Name()
	fake := newFakeIdleExpiryCloudflare(appID)
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	joining := newAdapterForFake(t, appID, server)
	publisher := joinParticipant(t, joining, "speaker")
	if _, err := joining.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatal(err)
	}
	listener := joinParticipant(t, joining, "listener")
	fake.advance(20 * time.Second)

	// The provider registry builds a new adapter for every request, so the first pull comes from another one.
	pulling := newAdapterForFake(t, appID, server)
	if _, err := pulling.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("first pull through a different adapter for the same app: %v", err)
	}
}

func TestFailedReplacementCreationReportsTheProviderFailure(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatal(err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.advance(20 * time.Second)
	fake.failNewSessions(http.StatusTooManyRequests)
	logs := captureAddTracksLogs(t)

	_, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))

	if !errors.Is(err, mediaplane.ErrProviderRateLimited) || errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a rate-limited replacement must surface the rate limit, got %v", err)
	}
	record := addTracksRecord(t, logs)
	if record["http_status"] != float64(http.StatusGone) || record["provider_code"] == "rate_limited" {
		t.Fatalf("the add-tracks record must describe the call to the gone session, not the failed replacement: %v", record)
	}
	fake.failNewSessions(0)
	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("the connection must still be replaceable after a failed replacement: %v", err)
	}
}

func TestAliasOfASwappedConnectionSurvivesTwelveHoursWithoutSignaling(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	speaker := joinParticipant(t, adapter, "speaker")
	fake.advance(20 * time.Second)
	if _, err := adapter.AddTracks(context.Background(), publishRequest(speaker)); err != nil {
		t.Fatal(err)
	}
	live := adapter.sessions.providerID(speaker)
	if live == speaker {
		t.Fatal("setup: the first publish did not swap the session")
	}

	// Media keeps flowing for a long Episode while the connection sends no signaling.
	adapter.sessions.now = func() time.Time { return time.Now().Add(13 * time.Hour) }
	joinParticipant(t, adapter, "later-joiner")
	if got := adapter.sessions.providerID(speaker); got != live {
		t.Fatalf("a swapped connection that still carries media lost its alias: %q, want %q", got, live)
	}

	adapter.sessions.now = func() time.Time { return time.Now().Add(9 * 24 * time.Hour) }
	joinParticipant(t, adapter, "much-later-joiner")
	if got := adapter.sessions.providerID(speaker); got != speaker {
		t.Fatalf("an alias idle for longer than any Episode must be dropped, got %q", got)
	}
}

func TestPartialPullThatCarriesAnAnswerStopsFurtherReplacement(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	listener := joinParticipant(t, adapter, "listener")
	partial := mediaplane.TracksRequest{
		ConnectionID: listener,
		Tracks: []mediaplane.Track{
			{Location: "remote", SessionID: listener, TrackName: "mic"},
			{Location: "remote", SessionID: "cf-unknown", TrackName: "mic"},
		},
	}
	response, err := adapter.AddTracks(context.Background(), partial)
	if !mediaplane.IsPartialRemoteTrackResponse(err) || response.SessionDescription == nil {
		t.Fatalf("setup: want an accepted partial pull, got response=%+v err=%v", response, err)
	}
	sessions := fake.sessionCount()
	fake.mu.Lock()
	fake.used[listener] = false
	fake.created[listener] = -time.Hour
	fake.mu.Unlock()

	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, listener)); !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a connection that negotiated through a partial pull must report not found, got %v", err)
	}
	if got := fake.sessionCount(); got != sessions {
		t.Fatalf("no replacement session for a negotiated connection: %d -> %d", sessions, got)
	}
}

func TestRenegotiatedConnectionIsNotReplaced(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	listener := joinParticipant(t, adapter, "listener")
	if err := adapter.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: listener, SessionDescription: mediaplane.SessionDescription{Type: "answer", SDP: "v=0"}}); err != nil {
		t.Fatal(err)
	}
	sessions := fake.sessionCount()
	fake.mu.Lock()
	fake.used[listener] = false
	fake.created[listener] = -time.Hour
	fake.mu.Unlock()

	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, listener)); !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		t.Fatalf("a connection that renegotiated must report not found, got %v", err)
	}
	if got := fake.sessionCount(); got != sessions {
		t.Fatalf("no replacement session after a renegotiation: %d -> %d", sessions, got)
	}
}

func TestRecoveredAddTracksLogsARecoveredCallWithTheProviderError(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	speaker := joinParticipant(t, adapter, "speaker")
	fake.advance(20 * time.Second)
	logs := captureAddTracksLogs(t)

	if _, err := adapter.AddTracks(context.Background(), publishRequest(speaker)); err != nil {
		t.Fatalf("first publish after 20 s idle: %v", err)
	}

	var records []map[string]any
	for line := range strings.Lines(logs.String()) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if record["event"] == "cloudflare_sfu.add_tracks" {
			records = append(records, record)
		}
	}
	if len(records) != 2 {
		t.Fatalf("add tracks records = %d, want 2 (the gone session and the retry):\n%s", len(records), logs.String())
	}
	first, retry := records[0], records[1]
	if first["outcome"] != "recovered" || first["level"] != "INFO" || first["retry"] != "session_replaced" || first["http_status"] != float64(http.StatusGone) || first["provider_code"] == "" {
		t.Fatalf("a recovered first attempt must read as recovered and keep the provider error: %v", first)
	}
	if retry["outcome"] != "ok" || retry["level"] != "INFO" || retry["retry"] != "after_session_replaced" {
		t.Fatalf("the retry must log its own success: %v", retry)
	}
}

// Cloudflare answers a call on a dropped session only after about 5 s, so the swap must happen
// before the first call when the connection has been idle long enough to be dropped.
func (f *fakeIdleExpiryCloudflare) elapsed() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clock
}

func followFakeClock(adapter Adapter, fake *fakeIdleExpiryCloudflare) {
	base := time.Unix(1_700_000_000, 0)
	adapter.sessions.mu.Lock()
	defer adapter.sessions.mu.Unlock()
	adapter.sessions.now = func() time.Time { return base.Add(fake.elapsed()) }
}

func requestsOnSession(fake *fakeIdleExpiryCloudflare, session string) int {
	count := 0
	for _, request := range fake.requestLog() {
		if strings.Contains(request, "/sessions/"+session+"/") {
			count++
		}
	}
	return count
}

func TestFirstPullOnAConnectionIdleForLongerThanTheProbeLimitNeverCallsItsDeadSession(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	followFakeClock(adapter, fake)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.advance(12 * time.Second)

	response, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher))
	if err != nil {
		t.Fatalf("first pull after 12 s idle: %v", err)
	}
	if len(response.Tracks) != 1 || response.Tracks[0].SessionID != publisher {
		t.Fatalf("pull must still name the publisher's connection ID %q: %+v", publisher, response.Tracks)
	}
	if got := requestsOnSession(fake, listener); got != 0 {
		t.Fatalf("the idle connection's own session must not be called: %d requests", got)
	}
}

func TestFirstPullOnAYoungConnectionUsesItsOwnSession(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	followFakeClock(adapter, fake)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	listener := joinParticipant(t, adapter, "listener")
	sessions := fake.sessionCount()
	fake.advance(5 * time.Second)

	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("first pull after 5 s: %v", err)
	}
	if got := requestsOnSession(fake, listener); got != 1 {
		t.Fatalf("a young connection must use its own session once, got %d requests", got)
	}
	if got := fake.sessionCount(); got != sessions {
		t.Fatalf("a young connection must not be swapped: sessions %d -> %d", sessions, got)
	}
}

func TestNegotiatedConnectionIsNeverSwappedBeforeItsNextCallHoweverLongItIdles(t *testing.T) {
	negotiate := map[string]func(t *testing.T, adapter Adapter, listener string){
		"partial pull with an answer": func(t *testing.T, adapter Adapter, listener string) {
			partial := mediaplane.TracksRequest{ConnectionID: listener, Tracks: []mediaplane.Track{
				{Location: "remote", SessionID: listener, TrackName: "mic"},
				{Location: "remote", SessionID: "cf-unknown", TrackName: "mic"},
			}}
			response, err := adapter.AddTracks(context.Background(), partial)
			if !mediaplane.IsPartialRemoteTrackResponse(err) || response.SessionDescription == nil {
				t.Fatalf("setup: want an accepted partial pull, got response=%+v err=%v", response, err)
			}
		},
		"renegotiate": func(t *testing.T, adapter Adapter, listener string) {
			answer := mediaplane.SessionDescription{Type: "answer", SDP: "v=0"}
			if err := adapter.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: listener, SessionDescription: answer}); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, negotiated := range negotiate {
		t.Run(name, func(t *testing.T) {
			adapter, fake := newExpiryAdapter(t)
			followFakeClock(adapter, fake)
			listener := joinParticipant(t, adapter, "listener")
			negotiated(t, adapter, listener)
			sessions, own := fake.sessionCount(), requestsOnSession(fake, listener)
			fake.advance(12 * time.Second)

			if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, listener)); err != nil {
				t.Fatalf("pull on a negotiated connection: %v", err)
			}
			if got := fake.sessionCount(); got != sessions {
				t.Fatalf("a negotiated connection must not be swapped: sessions %d -> %d", sessions, got)
			}
			if got := requestsOnSession(fake, listener); got != own+1 {
				t.Fatalf("the pull must use the connection's own session: requests %d -> %d", own, got)
			}
		})
	}
}

func TestSwappedConnectionThatNegotiatedIsNotSwappedAgainWhenItIdles(t *testing.T) {
	adapter, fake := newExpiryAdapter(t)
	followFakeClock(adapter, fake)
	publisher := joinParticipant(t, adapter, "speaker")
	if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
		t.Fatalf("publish: %v", err)
	}
	listener := joinParticipant(t, adapter, "listener")
	fake.advance(12 * time.Second)
	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("first pull swaps and negotiates: %v", err)
	}
	sessions := fake.sessionCount()
	fake.advance(12 * time.Second)

	if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
		t.Fatalf("second pull: %v", err)
	}
	if got := fake.sessionCount(); got != sessions {
		t.Fatalf("a negotiated swapped connection must keep its live session: sessions %d -> %d", sessions, got)
	}
}

func replacementOutcomes(t *testing.T, run func()) map[string]int64 {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	counter, err := meterProvider.Meter("replacement-test").Int64Counter("chalk.api.cloudflare_sfu.session_replacements")
	if err != nil {
		t.Fatal(err)
	}
	old := sfuSessionReplacements
	sfuSessionReplacements = counter
	t.Cleanup(func() {
		sfuSessionReplacements = old
		_ = meterProvider.Shutdown(context.Background())
	})
	run()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]int64{}
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, point := range sum.DataPoints {
				outcome, _ := point.Attributes.Value("outcome")
				outcomes[outcome.AsString()] += point.Value
			}
		}
	}
	return outcomes
}

func TestSessionReplacementsAreCountedByOutcome(t *testing.T) {
	t.Run("proactive swap of a long-idle connection", func(t *testing.T) {
		adapter, fake := newExpiryAdapter(t)
		followFakeClock(adapter, fake)
		publisher := joinParticipant(t, adapter, "speaker")
		listener := joinParticipant(t, adapter, "listener")
		if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
			t.Fatal(err)
		}
		fake.advance(12 * time.Second)
		got := replacementOutcomes(t, func() {
			if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
				t.Fatal(err)
			}
		})
		if len(got) != 1 || got["proactive"] != 1 {
			t.Fatalf("want one proactive replacement, got %v", got)
		}
	})
	t.Run("reactive recovery when the registry clock has not reached the probe limit", func(t *testing.T) {
		adapter, fake := newExpiryAdapter(t)
		publisher := joinParticipant(t, adapter, "speaker")
		listener := joinParticipant(t, adapter, "listener")
		if _, err := adapter.AddTracks(context.Background(), publishRequest(publisher)); err != nil {
			t.Fatal(err)
		}
		fake.advance(20 * time.Second)
		got := replacementOutcomes(t, func() {
			if _, err := adapter.AddTracks(context.Background(), pullRequest(listener, publisher)); err != nil {
				t.Fatal(err)
			}
		})
		if len(got) != 1 || got["recovered"] != 1 {
			t.Fatalf("want one recovered replacement, got %v", got)
		}
	})
}
