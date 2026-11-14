package mediapublications

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type receiveHealthRepositoryStub struct {
	reconciliationRepositoryStub
	episodes []ReceiveHealthEpisode
	err      error
}

func (r *receiveHealthRepositoryStub) ListReceiveHealthEpisodes(_ context.Context, limit int) ([]ReceiveHealthEpisode, error) {
	return r.episodes[:min(limit, len(r.episodes))], r.err
}

type receiveHealthFixture struct {
	service    Service
	repository *receiveHealthRepositoryStub
	now        time.Time
	logs       bytes.Buffer
	input      ListenerPullInput
}

func newReceiveHealthFixture(t *testing.T) *receiveHealthFixture {
	t.Helper()
	f := &receiveHealthFixture{now: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), repository: &receiveHealthRepositoryStub{}}
	f.service = newService(f.repository, func() time.Time { return f.now })
	tenant := reconciliationTestID(t, "11111111-1111-4111-8111-111111111111")
	episode := reconciliationTestID(t, "22222222-2222-4222-8222-222222222222")
	publisher := reconciliationTestID(t, "33333333-3333-4333-8333-333333333333")
	listener := reconciliationTestID(t, "44444444-4444-4444-8444-444444444444")
	key := ReceiveHealthEpisode{TenantID: tenant, EpisodeID: episode, SpaceID: reconciliationTestID(t, "55555555-5555-4555-8555-555555555555")}
	f.repository.episodes = []ReceiveHealthEpisode{key}
	f.repository.participants = []PublicationParticipant{{ID: publisher, Generation: 1, ConnectionID: "publisher-connection"}, {ID: listener, Generation: 1, ConnectionID: "listener-connection"}}
	_, err := f.service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: tenant, EpisodeID: episode, ParticipantID: publisher, ParticipantGeneration: 1, ConnectionID: "publisher-connection",
		Tracks: []PublishedTrack{{Source: "microphone", MID: "camera-mid", TrackName: "camera-track"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	reference, err := ParseReference(f.repository.observations[0].Publications[0].PublicationID)
	if err != nil {
		t.Fatal(err)
	}
	f.repository.participants[0].ConnectionID = reference.ConnectionID
	f.input = ListenerPullInput{ReceiveHealthEpisode: key, ParticipantID: listener, ParticipantGeneration: 1, ConnectionID: "listener-connection",
		Requested: []mediaplane.Track{{Location: "remote", SessionID: reference.ConnectionID, TrackName: reference.TrackName}}}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&f.logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	f.sample(0)
	return f
}

func (f *receiveHealthFixture) sample(advance time.Duration) {
	f.now = f.now.Add(advance)
	f.service.sampleReceiveHealth(context.Background())
}

func (f *receiveHealthFixture) success() {
	track := f.input.Requested[0]
	track.Mid = "receiver-mid"
	f.input.Response = mediaplane.TracksResponse{Tracks: []mediaplane.Track{track}}
	f.input.Err = nil
	f.service.ObserveListenerPull(context.Background(), f.input)
}

func (f *receiveHealthFixture) events(t *testing.T, event string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(f.logs.String()), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["event"] == event {
			events = append(events, record)
		}
	}
	return events
}

func TestReceiveHealthFailedPullCarriesOnlyBoundedPerTrackKind(t *testing.T) {
	for _, code := range []string{"empty_track_error", "track_not_found", "private-error-text"} {
		t.Run(code, func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			track := f.input.Requested[0]
			f.input.Response.TrackErrors = []mediaplane.TrackError{{ConnectionID: track.SessionID, TrackName: track.TrackName, Code: code}}
			f.input.Err = errors.New("private transport error")
			f.service.ObserveListenerPull(context.Background(), f.input)
			f.sample(16 * time.Second)
			events := f.events(t, "media.listener_publication_unpulled")
			want := code
			if code == "private-error-text" {
				want = "unknown"
			}
			if len(events) != 1 || events[0]["step"] != "pull_failed" || events[0]["error_kind"] != want {
				t.Fatalf("events = %+v", events)
			}
			if strings.Contains(f.logs.String(), "private") {
				t.Fatalf("raw error escaped: %s", &f.logs)
			}
			f.sample(44 * time.Second)
			summary := f.events(t, "media.listener_publication_summary")
			if len(summary) != 1 || summary[0]["pull_failed_count"] != float64(1) {
				t.Fatalf("summary = %+v", summary)
			}
		})
	}
}

func TestReceiveHealthPublicationReferencesNeverReachLogs(t *testing.T) {
	const trackName = "audio@example.invalid"
	const mid = "mid@example.invalid"
	for _, format := range []string{"generated", "legacy"} {
		for _, step := range []string{"no_pull_attempted", "pull_failed"} {
			t.Run(format+"/"+step, func(t *testing.T) {
				f := newReceiveHealthFixture(t)
				connection := f.input.Requested[0].SessionID
				reference := encodeReference(connection, mid, trackName, 1)
				if format == "legacy" {
					reference = connection + "|" + trackName
				}
				f.repository.observations[0].Publications[0].PublicationID = reference
				f.sample(0)
				if step == "pull_failed" {
					f.input.Requested[0].TrackName = trackName
					f.input.Response.TrackErrors = []mediaplane.TrackError{{ConnectionID: connection, TrackName: trackName, Code: trackName}}
					f.input.Err = errors.New(trackName)
					f.service.ObserveListenerPull(context.Background(), f.input)
				}
				f.sample(16 * time.Second)
				f.sample(44 * time.Second)
				f.repository.err = errors.New(trackName)
				f.sample(0)
				for line := range strings.Lines(f.logs.String()) {
					for _, private := range []string{trackName, mid, reference, strings.TrimPrefix(reference, publicationReferencePrefix)} {
						if strings.Contains(line, private) {
							t.Fatal("raw or reversibly encoded publication data reached telemetry")
						}
					}
					var record map[string]any
					if err := json.Unmarshal([]byte(line), &record); err != nil {
						t.Fatal(err)
					}
					if _, ok := record["publication_id"]; ok {
						t.Fatal("raw publication_id field must not be logged")
					}
				}
				events := f.events(t, "media.listener_publication_unpulled")
				wantHash := fmt.Sprintf("%x", sha256.Sum256([]byte(reference)))
				if len(events) != 1 || events[0]["publication_id_hash"] != wantHash || events[0]["step"] != step {
					t.Fatalf("unpulled events = %+v", events)
				}
				if step == "pull_failed" && events[0]["error_kind"] != "unknown" {
					t.Fatal("provider error kind must be allowlisted")
				}
				for _, event := range []string{"media.listener_publication_summary", "media.listener_publication_sampling_incomplete"} {
					if len(f.events(t, event)) != 1 {
						t.Fatalf("expected one %s event", event)
					}
				}
			})
		}
	}
}

func TestReceiveHealthSuccessfulPullIsFurthestStep(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.success()
	f.input.Response = mediaplane.TracksResponse{}
	f.input.Err = errors.New("retry failed")
	f.service.ObserveListenerPull(context.Background(), f.input)
	f.sample(time.Minute)
	if f.logs.Len() != 0 {
		t.Fatalf("retry downgraded a success: %s", &f.logs)
	}
}

func TestReceiveHealthRetiresDepartedPausedAndReplacedPublications(t *testing.T) {
	for _, mutation := range []string{"departed", "paused", "closed", "stale_generation", "camera"} {
		t.Run(mutation, func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			publication := &f.repository.observations[0].Publications[0]
			switch mutation {
			case "departed":
				f.repository.participants = f.repository.participants[:1]
			case "paused":
				publication.Enabled = false
			case "closed":
				publication.PublicationID = ""
			case "stale_generation":
				f.repository.participants[0].Generation++
			case "camera":
				publication.Source = "camera"
			}
			f.sample(time.Minute)
			if f.logs.Len() != 0 {
				t.Fatalf("inactive pair emitted: %s", &f.logs)
			}
		})
	}
}

func TestReceiveHealthPartialResponseCountsEachTrackIndependently(t *testing.T) {
	f := newReceiveHealthFixture(t)
	_, err := f.service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: f.input.TenantID, EpisodeID: f.input.EpisodeID, ParticipantID: f.repository.participants[0].ID,
		ParticipantGeneration: 1, ConnectionID: f.input.Requested[0].SessionID,
		Tracks: []PublishedTrack{{Source: "screen_audio", MID: "screen-mid", TrackName: "screen-audio"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.input.Requested = append(f.input.Requested, mediaplane.Track{Location: "remote", SessionID: f.input.Requested[0].SessionID, TrackName: "screen-audio"})
	f.success()
	f.sample(time.Minute)
	events := f.events(t, "media.listener_publication_unpulled")
	if len(events) != 1 || events[0]["error_kind"] != "missing_result" {
		t.Fatalf("events = %+v", events)
	}
	summary := f.events(t, "media.listener_publication_summary")
	if len(summary) != 1 || summary[0]["pull_succeeded_count"] != float64(1) || summary[0]["pull_failed_count"] != float64(1) {
		t.Fatalf("summary = %+v", summary)
	}
}

func TestReceiveHealthMemoryAndOutputAreBounded(t *testing.T) {
	f := newReceiveHealthFixture(t)
	h := f.service.receiveHealth
	for i := 0; i < receiveHealthMaxEpisodes+5; i++ {
		key := f.input.ReceiveHealthEpisode
		key.EpisodeID = reconciliationTestID(t, fmt.Sprintf("%08x-2222-4222-8222-222222222222", i))
		h.reconcile(key, nil, f.repository.participants)
	}
	if len(h.episodes) != receiveHealthMaxEpisodes {
		t.Fatalf("Episode cap = %d", len(h.episodes))
	}
	h.clear()
	for i := 0; i < 40; i++ {
		participant := f.repository.participants[1]
		participant.ID = reconciliationTestID(t, fmt.Sprintf("%08x-4444-4444-8444-444444444444", i))
		f.repository.participants = append(f.repository.participants, participant)
		publication := f.repository.observations[0].Publications[0]
		publication.PublicationID = encodeReference(f.input.Requested[0].SessionID, fmt.Sprint(i), fmt.Sprint(i), 1)
		f.repository.observations[0].Publications = append(f.repository.observations[0].Publications, publication)
	}
	f.sample(0)
	state := h.episodes[f.input.ReceiveHealthEpisode]
	if len(state.pairs) != receiveHealthMaxPairs || !state.truncated {
		t.Fatalf("pair cap = %d truncated = %v", len(state.pairs), state.truncated)
	}
	f.repository.err = errors.New("private database failure")
	f.sample(receiveHealthTTL + time.Second)
	if len(h.episodes) != 0 {
		t.Fatal("stale state survived sampling outage")
	}
}
