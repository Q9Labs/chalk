package accessgrants_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type activeRepositoryStub struct {
	synctokens.SubjectRepository
	err   error
	calls []string
}

func (r *activeRepositoryStub) SetParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string) error {
	r.calls = append(r.calls, "bind")
	return r.err
}

func (r *activeRepositoryStub) CheckParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string) error {
	return nil
}

func (r *activeRepositoryStub) ReplaceParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string, string) error {
	return nil
}

func (r *activeRepositoryStub) ReserveParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, string, string, [32]byte) error {
	return nil
}

func (r *activeRepositoryStub) LoadParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, [32]byte) (*accessgrants.StoredRefreshReplay, error) {
	return nil, nil
}

func (r *activeRepositoryStub) CompleteParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, string, string, accessgrants.RefreshReplay) error {
	r.calls = append(r.calls, "complete")
	return r.err
}

type publicationReaderStub struct {
	repository *activeRepositoryStub
	reads      []string
	err        error
}

func (p *publicationReaderStub) Latest(_ context.Context, tenantID, episodeID utilities.ID) (mediapublications.Snapshot, error) {
	p.reads = append(p.reads, tenantID.String()+"/"+episodeID.String()+" after "+p.repository.calls[len(p.repository.calls)-1])
	return mediapublications.Snapshot{}, p.err
}

func replacementSubjects(t *testing.T) (accessgrants.Subject, accessgrants.Subject) {
	t.Helper()
	fixture := newCredentialFixture(t)
	previous := fixture.subject
	next := previous
	next.CloudflareConnectionID = "replacement-connection"
	return previous, next
}

// A replaced connection's publication must be retired and announced in the same
// request that moves the participant, or listeners keep pulling it until a
// later read happens to retire it.
func TestReplacementGrantRetiresTheAbandonedPublication(t *testing.T) {
	previous, next := replacementSubjects(t)
	for name, grant := range map[string]func(accessgrants.ActiveAuthorizer) error{
		"bind": func(a accessgrants.ActiveAuthorizer) error {
			return a.BindParticipantMediaConnection(context.Background(), next)
		},
		"complete": func(a accessgrants.ActiveAuthorizer) error {
			return a.CompleteParticipantMediaRefresh(context.Background(), previous, next, accessgrants.RefreshReplay{})
		},
	} {
		t.Run(name, func(t *testing.T) {
			repository := &activeRepositoryStub{}
			publications := &publicationReaderStub{repository: repository}
			if err := grant(accessgrants.NewActiveAuthorizer(repository, publications)); err != nil {
				t.Fatal(err)
			}
			want := next.TenantID.String() + "/" + next.EpisodeID.String() + " after " + name
			if len(publications.reads) != 1 || publications.reads[0] != want {
				t.Fatalf("publication reads = %v, want [%s]", publications.reads, want)
			}
		})
	}
}

func TestReplacementGrantDoesNotRetireWhenTheBindingFails(t *testing.T) {
	_, next := replacementSubjects(t)
	repository := &activeRepositoryStub{err: errors.New("superseded")}
	publications := &publicationReaderStub{repository: repository}
	if err := accessgrants.NewActiveAuthorizer(repository, publications).BindParticipantMediaConnection(context.Background(), next); err == nil {
		t.Fatal("bind error was swallowed")
	}
	if len(publications.reads) != 0 {
		t.Fatalf("publication reads after failed bind = %v", publications.reads)
	}
}

// The binding is already committed when the announcement fails, and the read
// path retires the publication on its next call, so the grant still succeeds.
func TestReplacementGrantSucceedsWhenTheAnnouncementFails(t *testing.T) {
	_, next := replacementSubjects(t)
	repository := &activeRepositoryStub{}
	publications := &publicationReaderStub{repository: repository, err: errors.New("database down")}
	if err := accessgrants.NewActiveAuthorizer(repository, publications).BindParticipantMediaConnection(context.Background(), next); err != nil {
		t.Fatalf("grant failed after a committed binding: %v", err)
	}
}
