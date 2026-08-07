package episodes_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type captureRepository struct {
	creates    []episodes.CreateEpisodeInput
	admissions []episodes.AdmitParticipantInput
}

type commitObserver struct {
	episode episodes.Episode
}

func (o *commitObserver) EpisodeCommitted(episode episodes.Episode) {
	o.episode = episode
}

type panicCommitObserver struct{}

func (panicCommitObserver) EpisodeCommitted(episodes.Episode) {
	panic("diagnostic observer failed")
}

func (r *captureRepository) CreateEpisode(_ context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	r.creates = append(r.creates, input)
	return episodes.Episode{ID: input.ID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusActive}, nil
}
func (r *captureRepository) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, errors.New("unexpected get")
}
func (r *captureRepository) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, errors.New("unexpected list")
}
func (r *captureRepository) AdmitParticipant(_ context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	r.admissions = append(r.admissions, input)
	return episodes.Admission{}, nil
}
func (r *captureRepository) RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return episodes.Removal{}, errors.New("unexpected removal")
}
func (r *captureRepository) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return episodes.EndRequest{}, errors.New("unexpected end")
}
func (r *captureRepository) SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return episodes.ControlRequest{}, errors.New("unexpected deadline")
}

func TestServiceDerivesStableEpisodeCreateFingerprint(t *testing.T) {
	repository := &captureRepository{}
	service := episodes.NewService(repository)
	input := episodes.CreateEpisodeInput{
		TenantID:       mustID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:        mustID(t, "22222222-2222-4222-8222-222222222222"),
		Metadata:       []byte(`{"topic":"planning","settings":{"b":2,"a":1}}`),
		ConfigSnapshot: validSnapshot(t),
		Request:        episodes.Request{Key: "episode-create-request-0001"},
	}
	if _, err := service.CreateEpisode(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	retry := input
	retry.Metadata = []byte(`{"settings":{"a":1,"b":2},"topic":"planning"}`)
	if _, err := service.CreateEpisode(context.Background(), retry); err != nil {
		t.Fatal(err)
	}
	changed := input
	changed.Metadata = []byte(`{"topic":"different"}`)
	if _, err := service.CreateEpisode(context.Background(), changed); err != nil {
		t.Fatal(err)
	}
	if repository.creates[0].ID == repository.creates[1].ID {
		t.Fatal("service reused generated episode id")
	}
	if repository.creates[0].Request.Fingerprint != repository.creates[1].Request.Fingerprint {
		t.Fatal("semantic retries produced different fingerprints")
	}
	if repository.creates[0].Request.Fingerprint == repository.creates[2].Request.Fingerprint {
		t.Fatal("different episode input produced the same fingerprint")
	}
}

func TestServiceNotifiesCommitObserverWithoutChangingCommittedResult(t *testing.T) {
	repository := &captureRepository{}
	observer := &commitObserver{}
	input := episodes.CreateEpisodeInput{
		TenantID:       mustID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:        mustID(t, "22222222-2222-4222-8222-222222222222"),
		Metadata:       []byte(`{"topic":"planning"}`),
		ConfigSnapshot: validSnapshot(t),
		Request:        episodes.Request{Key: "episode-create-observer-0001"},
	}
	created, err := episodes.NewService(repository).WithCommitObserver(observer).CreateEpisode(context.Background(), input)
	if err != nil {
		t.Fatalf("create episode: %v", err)
	}
	if observer.episode.ID != created.ID {
		t.Fatalf("observer saw episode %s, want committed episode %s", observer.episode.ID, created.ID)
	}

	panicCreated, err := episodes.NewService(repository).WithCommitObserver(panicCommitObserver{}).CreateEpisode(context.Background(), input)
	if err != nil {
		t.Fatalf("observer failure changed committed result: %v", err)
	}
	if panicCreated.ID.IsZero() {
		t.Fatal("observer failure returned zero committed episode")
	}
}

func TestServiceAdmissionUsesRoleAndIdentityID(t *testing.T) {
	repository := &captureRepository{}
	service := episodes.NewService(repository)
	input := episodes.AdmitParticipantInput{
		TenantID:      mustID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:       mustID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:     mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		IdentityID:    mustID(t, "55555555-5555-4555-8555-555555555555"),
		Name:          " Ada ", Role: "collaborator", Request: episodes.Request{Key: "episode-admit-request-0001"},
	}
	if _, err := service.AdmitParticipant(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	admission := repository.admissions[0]
	if admission.Name != "Ada" || admission.Role != "collaborator" || admission.IdentityID != input.IdentityID {
		t.Fatalf("normalized admission = %#v", admission)
	}
	if got := string(admission.Request.Payload()); got != `{"display_name":"Ada","participant_id":"44444444-4444-4444-8444-444444444444","role":"collaborator"}` {
		t.Fatalf("admission payload = %s", got)
	}
}

func TestServiceRejectsMissingRoleBeforeRepository(t *testing.T) {
	repository := &captureRepository{}
	service := episodes.NewService(repository)
	input := episodes.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), SpaceID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		Name: "Ada", Request: episodes.Request{Key: "episode-admit-request-0001"},
	}
	if _, err := service.AdmitParticipant(context.Background(), input); !errors.Is(err, episodes.ErrInvalidRole) {
		t.Fatalf("error = %v, want invalid role", err)
	}
	if len(repository.admissions) != 0 {
		t.Fatal("repository received invalid admission")
	}
}

func TestNewInitialControlStateContainsSnapshotAndNoHostAuthority(t *testing.T) {
	state, err := episodes.NewInitialControlState(episodes.InitialControlPolicy{ConfigSnapshot: validSnapshot(t)})
	if err != nil {
		t.Fatal(err)
	}
	var projection map[string]any
	if err := json.Unmarshal(state.FoldedState, &projection); err != nil {
		t.Fatal(err)
	}
	if _, ok := projection["host_exit_policy"]; ok {
		t.Fatal("initial control retained host exit policy")
	}
	if _, ok := projection["host_participant_id"]; ok {
		t.Fatal("initial control retained host participant authority")
	}
	if projection["status"] != episodes.EpisodeStatusActive {
		t.Fatalf("status = %#v", projection["status"])
	}
	if _, ok := projection["config_snapshot"]; !ok {
		t.Fatal("initial control omitted config snapshot")
	}
}

func validSnapshot(t *testing.T) []byte {
	t.Helper()
	return []byte(`{"roles":{"owner":["publishAudio","subscribe","endEpisode"],"collaborator":["publishAudio","subscribe","sendChat","drawWhiteboard"],"observer":["subscribe","sendReaction"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":3600,"maximum_episode_duration_seconds":7200,"linger_window_seconds":30}`)
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

var _ = time.UTC
