package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type blockingReceiveHealthRepository struct {
	*receiveHealthRepositoryStub
	method  string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	reads   atomic.Int32
}

func (r *blockingReceiveHealthRepository) read(method string) {
	r.reads.Add(1)
	if method == r.method {
		r.once.Do(func() { close(r.entered) })
		<-r.release
	}
}

func (r *blockingReceiveHealthRepository) LatestObservation(context.Context, utilities.ID, utilities.ID) (provideroperations.Observation, error) {
	r.read("publications")
	return r.observations[0], nil
}

func (r *blockingReceiveHealthRepository) ListPublicationParticipants(context.Context, utilities.ID, utilities.ID) ([]PublicationParticipant, error) {
	r.read("participants")
	return r.participants, nil
}

func awaitReceiveHealth(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal(message)
	}
}

func TestReceiveHealthSlowRepositoryDoesNotBlockAnotherEpisodePull(t *testing.T) {
	for _, method := range []string{"publications", "participants"} {
		t.Run(method, func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			repository := &blockingReceiveHealthRepository{receiveHealthRepositoryStub: f.repository, method: method,
				entered: make(chan struct{}), release: make(chan struct{})}
			f.service.repository = repository
			sampled := make(chan struct{})
			var pulled chan struct{}
			go func() {
				defer close(sampled)
				f.service.sampleReceiveHealth(context.Background())
			}()
			t.Cleanup(func() {
				close(repository.release)
				awaitReceiveHealth(t, sampled, "sampler did not finish after releasing repository")
				if pulled != nil {
					awaitReceiveHealth(t, pulled, "pull did not finish after releasing repository")
				}
			})
			awaitReceiveHealth(t, repository.entered, "sampler did not enter repository")
			reads := repository.reads.Load()
			input := f.input
			input.EpisodeID = reconciliationTestID(t, "66666666-6666-4666-8666-666666666666")
			pulled = make(chan struct{})
			go func() {
				defer close(pulled)
				f.service.ObserveListenerPull(context.Background(), input)
			}()
			awaitReceiveHealth(t, pulled, "another Episode's pull waited for a diagnostic repository read")
			if got := repository.reads.Load(); got != reads {
				t.Fatalf("pull added repository reads: before %d, after %d", reads, got)
			}
		})
	}
}

type blockingReceiveHealthHandler struct {
	slog.Handler
	event   string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (h *blockingReceiveHealthHandler) Handle(_ context.Context, record slog.Record) error {
	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key == "event" && attr.Value.String() == h.event {
			h.once.Do(func() { close(h.entered) })
			<-h.release
		}
		return true
	})
	return nil
}

func TestReceiveHealthSlowLogsDoNotBlockPulls(t *testing.T) {
	for _, event := range []string{"media.listener_publication_unpulled", "media.listener_publication_summary", "media.listener_publication_sampling_incomplete"} {
		t.Run(event, func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			f.now = f.now.Add(time.Minute)
			if event == "media.listener_publication_sampling_incomplete" {
				f.repository.err = errors.New("sampling unavailable")
			}
			handler := &blockingReceiveHealthHandler{Handler: slog.Default().Handler(), event: event, entered: make(chan struct{}), release: make(chan struct{})}
			slog.SetDefault(slog.New(handler))
			sampled := make(chan struct{})
			go func() {
				defer close(sampled)
				f.service.sampleReceiveHealth(context.Background())
			}()
			var pulls []<-chan struct{}
			t.Cleanup(func() {
				close(handler.release)
				awaitReceiveHealth(t, sampled, "sampler did not finish after releasing logs")
				for _, pulled := range pulls {
					awaitReceiveHealth(t, pulled, "pull did not finish after releasing logs")
				}
			})
			awaitReceiveHealth(t, handler.entered, "sampler did not enter log handler")
			for _, episode := range []string{"66666666-6666-4666-8666-666666666666", f.input.EpisodeID.String()} {
				input := f.input
				input.EpisodeID = reconciliationTestID(t, episode)
				pulled := make(chan struct{})
				pulls = append(pulls, pulled)
				go func() {
					defer close(pulled)
					f.service.ObserveListenerPull(context.Background(), input)
				}()
				awaitReceiveHealth(t, pulled, "pull waited for a diagnostic log handler")
			}
		})
	}
}

func TestReceiveHealthPullBeforeFirstSampleIsRetained(t *testing.T) {
	for _, success := range []bool{false, true} {
		t.Run(fmt.Sprint(success), func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			start := f.now
			f.service.receiveHealth.clear()
			if success {
				f.success()
			} else {
				f.service.ObserveListenerPull(context.Background(), f.input)
				f.now = f.now.Add(10 * time.Second)
				f.service.ObserveListenerPull(context.Background(), f.input)
			}
			f.now = start.Add(16 * time.Second)
			f.sample(0)
			events := f.events(t, "media.listener_publication_unpulled")
			if success && len(events) != 0 {
				t.Fatalf("early success was lost: %+v", events)
			}
			if !success && (len(events) != 1 || events[0]["step"] != "pull_failed" || events[0]["duration_ms"] != float64(16000)) {
				t.Fatalf("early failure was lost: %+v", events)
			}
		})
	}
}

func TestReceiveHealthCachedPullDoesNotCrossListenerGeneration(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.success()
	f.repository.participants[1].Generation++
	f.sample(time.Second)
	f.sample(16 * time.Second)
	if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 1 || events[0]["step"] != "no_pull_attempted" {
		t.Fatalf("cached pull crossed listener generation: %+v", events)
	}
}

func TestReceiveHealthPendingPullsAreBoundedAndExpire(t *testing.T) {
	f := newReceiveHealthFixture(t)
	for i := 0; i < receiveHealthMaxPairs+5; i++ {
		input := f.input
		input.ConnectionID = fmt.Sprint(i)
		f.service.ObserveListenerPull(context.Background(), input)
	}
	state := f.service.receiveHealth.episodes[f.input.ReceiveHealthEpisode]
	if len(state.pulls) != receiveHealthMaxPairs || !state.truncated {
		t.Fatalf("pending pulls = %d, truncated = %v", len(state.pulls), state.truncated)
	}
	f.sample(receiveHealthTTL)
	f.sample(time.Second)
	if len(state.pulls) != 0 {
		t.Fatal("expired pending pulls retained")
	}
}

func TestReceiveHealthConcurrentSamplesAndPulls(t *testing.T) {
	f := newReceiveHealthFixture(t)
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Go(func() {
			for j := 0; j < 50; j++ {
				f.service.ObserveListenerPull(context.Background(), f.input)
			}
		})
	}
	for i := 0; i < 50; i++ {
		f.service.sampleReceiveHealth(context.Background())
	}
	workers.Wait()
}

func TestReceiveHealthReconciliationCollectsEventsAtomically(t *testing.T) {
	f := newReceiveHealthFixture(t)
	f.now = f.now.Add(16 * time.Second)
	h := f.service.receiveHealth
	collecting, pulling, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	h.now = func() time.Time {
		switch calls.Add(1) {
		case 2:
			close(collecting)
			<-release
		case 3:
			close(pulling)
		}
		return f.now
	}
	reconciled, pulled := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() {
		close(release)
		awaitReceiveHealth(t, reconciled, "reconciliation did not finish")
		awaitReceiveHealth(t, pulled, "pull did not finish")
	})
	go func() {
		defer close(reconciled)
		h.reconcile(f.input.ReceiveHealthEpisode, f.repository.observations[0].Publications, f.repository.participants)
	}()
	go func() {
		defer close(pulled)
		select {
		case <-collecting:
		case <-release:
			return
		}
		f.success()
	}()
	awaitReceiveHealth(t, collecting, "reconciliation returned without collecting events")
	awaitReceiveHealth(t, pulling, "pull did not reach the Episode lock")
	select {
	case <-pulled:
		t.Fatal("pull overtook atomic reconciliation and event collection")
	default:
	}
}

func TestReceiveHealthCachedPullDoesNotCrossPublicationReplacement(t *testing.T) {
	for _, stage := range []string{"before_sample", "after_sample", "before_first_sample", "mixed_before_first_sample"} {
		for _, replacement := range []string{"mid", "publisher_generation"} {
			t.Run(stage+"/"+replacement, func(t *testing.T) {
				f := newReceiveHealthFixture(t)
				if stage == "before_first_sample" || stage == "mixed_before_first_sample" {
					f.service.receiveHealth.clear()
				}
				f.success()
				if stage == "mixed_before_first_sample" {
					f.input.Requested[0].PublicationID = f.repository.observations[0].Publications[0].PublicationID
					f.success()
				}
				if stage != "before_sample" {
					f.sample(time.Second)
				}
				generation := int64(1)
				publication := &f.repository.observations[0].Publications[0]
				reference, err := ParseReference(publication.PublicationID)
				if err != nil {
					t.Fatal(err)
				}
				mid := "replacement-mid"
				if replacement == "publisher_generation" {
					generation++
					mid = reference.MID
					f.repository.participants[0].Generation = generation
				}
				publication.PublicationID = encodeReference(f.input.Requested[0].SessionID, mid, f.input.Requested[0].TrackName, generation)
				f.sample(time.Second)
				f.sample(16 * time.Second)
				if events := f.events(t, "media.listener_publication_unpulled"); len(events) != 1 || events[0]["step"] != "no_pull_attempted" {
					t.Fatalf("cached success crossed publication replacement: %+v", events)
				}
			})
		}
	}
}

func TestReceiveHealthReplacementPullBeforeSampleUsesPublicationIdentity(t *testing.T) {
	for _, success := range []bool{false, true} {
		t.Run(fmt.Sprint(success), func(t *testing.T) {
			f := newReceiveHealthFixture(t)
			f.success()
			publication := &f.repository.observations[0].Publications[0]
			publication.PublicationID = encodeReference(f.input.Requested[0].SessionID, "replacement-mid", f.input.Requested[0].TrackName, 1)
			f.input.Requested[0].PublicationID = publication.PublicationID
			if success {
				f.success()
			} else {
				f.input.Response = mediaplane.TracksResponse{}
				f.service.ObserveListenerPull(context.Background(), f.input)
			}
			f.sample(16 * time.Second)
			events := f.events(t, "media.listener_publication_unpulled")
			if success && len(events) != 0 {
				t.Fatalf("replacement success was lost: %+v", events)
			}
			if !success && (len(events) != 1 || events[0]["step"] != "pull_failed") {
				t.Fatalf("replacement failure inherited an earlier success: %+v", events)
			}
		})
	}
}
