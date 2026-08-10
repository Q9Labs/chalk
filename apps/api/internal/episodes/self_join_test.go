package episodes_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type selfRepository struct {
	joinInput   episodes.SelfJoinInput
	accessInput episodes.SelfAccessInput
	leaveInput  episodes.SelfLeaveInput
}

func (r *selfRepository) CreateEpisode(context.Context, episodes.CreateEpisodeInput) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}
func (r *selfRepository) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}
func (r *selfRepository) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, nil
}
func (r *selfRepository) AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error) {
	return episodes.Admission{}, nil
}
func (r *selfRepository) RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return episodes.Removal{}, nil
}
func (r *selfRepository) RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	return episodes.EndRequest{}, nil
}
func (r *selfRepository) SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return episodes.ControlRequest{}, nil
}
func (r *selfRepository) JoinSelf(_ context.Context, input episodes.SelfJoinInput) (episodes.SelfJoinResult, error) {
	r.joinInput = input
	return episodes.SelfJoinResult{Episode: episodes.Episode{TenantID: input.TenantID}, Participant: episodes.Participant{AccountID: input.AccountID}}, nil
}
func (r *selfRepository) FindSelf(_ context.Context, input episodes.SelfAccessInput) (episodes.SelfJoinResult, error) {
	r.accessInput = input
	return episodes.SelfJoinResult{}, nil
}
func (r *selfRepository) LeaveSelf(_ context.Context, input episodes.SelfLeaveInput) (episodes.SelfLeaveResult, error) {
	r.leaveInput = input
	return episodes.SelfLeaveResult{}, nil
}

// Keep the repository test seam honest when the pagination interface changes.
var _ episodes.Repository = (*selfRepository)(nil)

func TestServiceSelfJoinNormalizesAndDelegates(t *testing.T) {
	repository := &selfRepository{}
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	accountID := mustID(t, "22222222-2222-4222-8222-222222222222")
	result, err := episodes.NewService(repository).JoinSelf(context.Background(), episodes.SelfJoinInput{TenantID: tenantID, AccountID: accountID, SpaceSlug: "  team-space ", DisplayName: " Ada ", Request: episodes.Request{Key: "dashboard-self-join-0001"}})
	if err != nil {
		t.Fatal(err)
	}
	if repository.joinInput.SpaceSlug != "team-space" || repository.joinInput.DisplayName != "Ada" || repository.joinInput.AccountID != accountID || result.Episode.TenantID != tenantID {
		t.Fatalf("normalized self join = %#v / %#v", repository.joinInput, result)
	}
	if repository.joinInput.Request.Fingerprint == ([32]byte{}) {
		t.Fatal("self join did not derive a fingerprint")
	}
}

func TestServiceSelfAccessAndLeaveDelegate(t *testing.T) {
	repository := &selfRepository{}
	service := episodes.NewService(repository)
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	accountID := mustID(t, "22222222-2222-4222-8222-222222222222")
	if _, err := service.FindSelf(context.Background(), episodes.SelfAccessInput{TenantID: tenantID, AccountID: accountID, SpaceSlug: "studio"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LeaveSelf(context.Background(), episodes.SelfLeaveInput{TenantID: tenantID, AccountID: accountID, SpaceSlug: "studio", ParticipantGeneration: 2, Request: episodes.Request{Key: "dashboard-self-leave-0001"}}); err != nil {
		t.Fatal(err)
	}
	if repository.accessInput.AccountID != accountID || repository.leaveInput.ParticipantGeneration != 2 || repository.leaveInput.Request.Fingerprint == ([32]byte{}) {
		t.Fatalf("self access/leave delegation = %#v / %#v", repository.accessInput, repository.leaveInput)
	}
}

func TestServiceSelfJoinRejectsInvalidAccountAndSlugBeforeRepository(t *testing.T) {
	repository := &selfRepository{}
	service := episodes.NewService(repository)
	validTenant := mustID(t, "11111111-1111-4111-8111-111111111111")
	tests := []struct {
		name  string
		input episodes.SelfJoinInput
		want  error
	}{
		{name: "account", input: episodes.SelfJoinInput{TenantID: validTenant, SpaceSlug: "studio", DisplayName: "Ada", Request: episodes.Request{Key: "dashboard-self-join-0001"}}, want: episodes.ErrInvalidAccountID},
		{name: "slug", input: episodes.SelfJoinInput{TenantID: validTenant, AccountID: mustID(t, "22222222-2222-4222-8222-222222222222"), SpaceSlug: " ", DisplayName: "Ada", Request: episodes.Request{Key: "dashboard-self-join-0001"}}, want: episodes.ErrInvalidSpaceSlug},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.JoinSelf(context.Background(), test.input); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if repository.joinInput.TenantID != (utilities.ID{}) {
				t.Fatal("repository received invalid self join")
			}
		})
	}
}
