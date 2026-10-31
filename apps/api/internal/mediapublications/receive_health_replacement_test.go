package mediapublications

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestReviewReceiveHealthReplacementBeforeFirstSample(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.service.receiveHealth.clear()
	f.success()
	f.replacePublication(t)
	f.sample(time.Second)
	f.sample(16 * time.Second)
	events := f.events(t, "media.listener_publication_unpulled")
	if len(events) != 1 || events[0]["step"] != "no_pull_attempted" {
		t.Fatalf("replacement never pulled, want one no_pull_attempted warning; got %+v", events)
	}
}

func TestReviewReceiveHealthNewPublicationPullBeforeNextSample(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.replacePublication(t)
	f.success()
	f.sample(time.Second)
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 0 {
		t.Fatalf("replacement successfully pulled, want no warning; got %+v", events)
	}
}

func (f *receiveHealthFixture) replacePublication(t *testing.T) {
	t.Helper()
	publisher := f.repository.participants[0]
	_, err := f.service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: f.input.TenantID, EpisodeID: f.input.EpisodeID, ParticipantID: publisher.ID,
		ParticipantGeneration: publisher.Generation, ConnectionID: f.input.Requested[0].SessionID,
		Tracks: []PublishedTrack{{Source: "microphone", MID: "replacement-mid", TrackName: f.input.Requested[0].TrackName}},
	})
	if err != nil {
		t.Fatalf("publish replacement: %v", err)
	}
}

func TestReceiveHealthPublicationWriteIgnoresTrackerCapacity(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(fmt.Sprint(unavailable), func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			h := f.service.receiveHealth
			if unavailable {
				f.service.receiveHealth = nil
			} else {
				clear(h.publications)
				for i := 0; i < receiveHealthMaxEpisodes; i++ {
					key := receivePublicationEpisodeKey{tenant: f.input.TenantID, episode: reconciliationTestID(t, fmt.Sprintf("%08x-2222-4222-8222-222222222222", i))}
					h.publications[key] = receivePublicationSnapshot{updatedAt: f.now}
				}
			}
			f.replacePublication(t)
			if len(f.repository.appendedInputs) != 2 || f.logs.Len() != 0 {
				t.Fatal("tracker capacity or availability changed the publication write")
			}
			if !unavailable && len(h.publications) != receiveHealthMaxEpisodes {
				t.Fatal("publication identity cache exceeded its Episode limit")
			}
		})
	}
}

type countingPublicationWriteRepository struct {
	*receiveHealthRepositoryStub
	reads int
}

func (r *countingPublicationWriteRepository) ListObservations(ctx context.Context, tenant, episode utilities.ID, cursor *provideroperations.Cursor, limit int) (provideroperations.ObservationPage, error) {
	r.reads++
	return r.receiveHealthRepositoryStub.ListObservations(ctx, tenant, episode, cursor, limit)
}

func (r *countingPublicationWriteRepository) ListPublicationParticipants(ctx context.Context, tenant, episode utilities.ID) ([]PublicationParticipant, error) {
	r.reads++
	return r.receiveHealthRepositoryStub.ListPublicationParticipants(ctx, tenant, episode)
}

func TestReceiveHealthPublicationWriteHookDoesNotReadOrLog(t *testing.T) {
	f := newReceiveHealthFixture(t)
	repository := &countingPublicationWriteRepository{receiveHealthRepositoryStub: f.repository}
	f.service.repository = repository
	f.replacePublication(t)
	// RecordPublishedTracks already reads the previous observation to merge it.
	if repository.reads != 1 || f.logs.Len() != 0 {
		t.Fatalf("publication write: repository reads = %d, logs = %s", repository.reads, &f.logs)
	}
	f.success()
	if repository.reads != 1 || f.logs.Len() != 0 {
		t.Fatal("pull observation performed a repository read or logged")
	}
}

type staleReceiveHealthRepository struct {
	*receiveHealthRepositoryStub
	snapshot provideroperations.Observation
	entered  chan struct{}
	release  chan struct{}
}

func (r *staleReceiveHealthRepository) LatestObservation(context.Context, utilities.ID, utilities.ID) (provideroperations.Observation, error) {
	close(r.entered)
	<-r.release
	return r.snapshot, nil
}

func TestReceiveHealthStaleSampleCannotOverwriteCommittedPublication(t *testing.T) {
	f := newReceiveHealthFixture(t)
	repository := &staleReceiveHealthRepository{receiveHealthRepositoryStub: f.repository,
		snapshot: f.repository.observations[0], entered: make(chan struct{}), release: make(chan struct{})}
	f.service.repository = repository
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		f.service.sampleReceiveHealth(context.Background())
	}()
	t.Cleanup(func() {
		close(repository.release)
		awaitReceiveHealth(t, sampled, "stale sampler did not finish")
	})
	awaitReceiveHealth(t, repository.entered, "sampler did not start reading")
	f.replacePublication(t)
	repository.release <- struct{}{}
	awaitReceiveHealth(t, sampled, "sampler did not finish")
	f.success()
	f.service.repository = f.repository
	f.sample(time.Second)
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 0 {
		t.Fatalf("stale sample rebound a replacement pull: %+v", events)
	}
}

func TestReceiveHealthPublicationIdentitiesAreBoundedAndExpire(t *testing.T) {
	f := newReceiveHealthFixture(t)
	publication := f.repository.observations[0].Publications[0]
	publications := make([]provideroperations.Publication, receiveHealthMaxPublications+5)
	for i := range publications {
		publications[i] = publication
		publications[i].PublicationID = encodeReference("publisher-connection", fmt.Sprint(i), fmt.Sprint(i), 1)
	}
	h := f.service.receiveHealth
	h.recordPublications(provideroperations.ObservationInput{TenantID: f.input.TenantID, EpisodeID: f.input.EpisodeID, Incarnation: 1, Sequence: 2, Publications: publications})
	identities := h.publicationIdentities(f.input.ReceiveHealthEpisode, f.now)
	if len(identities) != receiveHealthMaxPublications {
		t.Fatalf("retained publication identities = %d", len(identities))
	}
	if identities := h.publicationIdentities(f.input.ReceiveHealthEpisode, f.now.Add(receiveHealthTTL+time.Second)); len(identities) != 0 {
		t.Fatal("expired publication identities used to bind a pull")
	}
	f.now = f.now.Add(receiveHealthTTL + time.Second)
	f.replacePublication(t)
	identities = h.publicationIdentities(f.input.ReceiveHealthEpisode, f.now)
	key := receivePublicationKey{publisher: sha256.Sum256([]byte(f.input.Requested[0].SessionID)), track: sha256.Sum256([]byte(f.input.Requested[0].TrackName))}
	if len(identities) != 1 || identities[key] != sha256.Sum256([]byte(f.repository.appended.Publications[0].PublicationID)) {
		t.Fatal("expired publication identity cache was not replaced")
	}
}

func TestReceiveHealthUnidentifiedPullCannotCreditLaterPublication(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.service.receiveHealth.clear()
	clear(f.service.receiveHealth.publications)
	f.success()
	f.replacePublication(t)
	f.sample(time.Second)
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 1 || events[0]["step"] != "no_pull_attempted" {
		t.Fatalf("unidentified success crossed publication identity: %+v", events)
	}
}

type failedPublicationWriteRepository struct {
	*receiveHealthRepositoryStub
}

func (r *failedPublicationWriteRepository) AppendPublicationObservation(context.Context, provideroperations.ObservationInput, PublicationParticipant) (provideroperations.Observation, error) {
	return provideroperations.Observation{}, errors.New("publication write unavailable")
}

func TestReceiveHealthFailedPublicationWriteDoesNotUpdateIdentity(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.service.repository = &failedPublicationWriteRepository{receiveHealthRepositoryStub: f.repository}
	_, err := f.service.RecordPublishedTracks(context.Background(), RecordInput{
		TenantID: f.input.TenantID, EpisodeID: f.input.EpisodeID, ParticipantID: f.repository.participants[0].ID,
		ParticipantGeneration: 1, ConnectionID: f.input.Requested[0].SessionID,
		Tracks: []PublishedTrack{{Source: "microphone", MID: "replacement-mid", TrackName: f.input.Requested[0].TrackName}},
	})
	if err == nil {
		t.Fatal("publication write unexpectedly succeeded")
	}
	f.success()
	f.service.repository = f.repository
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 0 {
		t.Fatalf("failed write changed pull identity: %+v", events)
	}
}

func TestReceiveHealthOlderIncarnationCannotReplaceCommittedIdentity(t *testing.T) {
	f := newReceiveHealthFixture(t)
	old := f.repository.observations[0]
	f.replacePublication(t)
	key := receivePublicationEpisodeKey{tenant: f.input.TenantID, episode: f.input.EpisodeID}
	h := f.service.receiveHealth
	latest := h.publications[key]
	h.recordPublications(provideroperations.ObservationInput{TenantID: old.TenantID, EpisodeID: old.EpisodeID,
		Incarnation: old.Incarnation - 1, Sequence: latest.sequence + 100, Publications: old.Publications})
	f.success()
	f.sample(time.Second)
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 0 {
		t.Fatalf("older incarnation changed pull identity: %+v", events)
	}
}
