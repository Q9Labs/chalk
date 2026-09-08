package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecordingCaptureBindingSourceUsesFullIdentityAndFrozenBinding(t *testing.T) {
	identity := captureBindingIdentity(t)
	binding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "capture-app")
	if err != nil {
		t.Fatalf("create binding: %v", err)
	}
	snapshot, err := json.Marshal(struct {
		MediaPlaneBinding mediaplane.Binding `json:"media_plane_binding"`
	}{MediaPlaneBinding: binding})
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	queries := &recordingCaptureBindingQueriesStub{snapshot: snapshot}

	resolved, err := NewRecordingCaptureBindingSource(queries).ResolveBinding(context.Background(), identity)
	if err != nil {
		t.Fatalf("resolve binding: %v", err)
	}
	if resolved != binding {
		t.Fatalf("resolved binding = %+v, want %+v", resolved, binding)
	}
	want := sqlc.GetRecordingCaptureBindingParams{
		RecordingID: uuid(identity.RecordingID), TenantID: uuid(identity.TenantID),
		SpaceID: uuid(identity.SpaceID), EpisodeID: uuid(identity.EpisodeID),
	}
	if queries.calls != 1 || queries.params != want {
		t.Fatalf("query calls/params = %d/%+v, want 1/%+v", queries.calls, queries.params, want)
	}
}

func TestRecordingCaptureBindingSourceRejectsMissingOrInvalidAuthority(t *testing.T) {
	identity := captureBindingIdentity(t)
	validBinding, err := mediaplane.NewBinding("cf_sfu", mediaplane.BindingSourceDeploymentDefault, "capture-app")
	if err != nil {
		t.Fatalf("create binding: %v", err)
	}
	invalidBinding := validBinding
	invalidBinding.AdapterFingerprint = "wrong"
	invalidSnapshot, err := json.Marshal(struct {
		MediaPlaneBinding mediaplane.Binding `json:"media_plane_binding"`
	}{MediaPlaneBinding: invalidBinding})
	if err != nil {
		t.Fatalf("marshal invalid snapshot: %v", err)
	}

	tests := []struct {
		name     string
		identity captureplane.CaptureIdentity
		snapshot []byte
		queryErr error
	}{
		{name: "invalid identity", identity: captureplane.CaptureIdentity{}, snapshot: []byte(`{}`)},
		{name: "identity does not match recording", identity: identity, queryErr: pgx.ErrNoRows},
		{name: "empty snapshot", identity: identity},
		{name: "malformed snapshot", identity: identity, snapshot: []byte(`{`)},
		{name: "missing binding", identity: identity, snapshot: []byte(`{}`)},
		{name: "null binding", identity: identity, snapshot: []byte(`{"media_plane_binding":null}`)},
		{name: "invalid binding", identity: identity, snapshot: invalidSnapshot},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			queries := &recordingCaptureBindingQueriesStub{snapshot: test.snapshot, err: test.queryErr}
			_, err := NewRecordingCaptureBindingSource(queries).ResolveBinding(context.Background(), test.identity)
			if !errors.Is(err, mediaplane.ErrInvalidBinding) {
				t.Fatalf("error = %v, want ErrInvalidBinding", err)
			}
			if test.identity.Validate() != nil && queries.calls != 0 {
				t.Fatalf("invalid identity executed %d queries", queries.calls)
			}
		})
	}
}

func TestRecordingCaptureBindingSourcePreservesRepositoryFailure(t *testing.T) {
	repositoryErr := errors.New("database unavailable")
	queries := &recordingCaptureBindingQueriesStub{err: repositoryErr}

	_, err := NewRecordingCaptureBindingSource(queries).ResolveBinding(context.Background(), captureBindingIdentity(t))
	if !errors.Is(err, repositoryErr) {
		t.Fatalf("error = %v, want repository failure", err)
	}
	if errors.Is(err, mediaplane.ErrInvalidBinding) {
		t.Fatalf("repository failure misclassified as invalid binding: %v", err)
	}
}

type recordingCaptureBindingQueriesStub struct {
	snapshot []byte
	err      error
	params   sqlc.GetRecordingCaptureBindingParams
	calls    int
}

func (s *recordingCaptureBindingQueriesStub) GetRecordingCaptureBinding(_ context.Context, params sqlc.GetRecordingCaptureBindingParams) ([]byte, error) {
	s.calls++
	s.params = params
	return append([]byte(nil), s.snapshot...), s.err
}

func captureBindingIdentity(t *testing.T) captureplane.CaptureIdentity {
	t.Helper()
	parse := func(value string) utilities.ID {
		id, err := utilities.ParseID(value)
		if err != nil {
			t.Fatalf("parse id: %v", err)
		}
		return id
	}
	return captureplane.CaptureIdentity{
		TenantID:    parse("11111111-1111-4111-8111-111111111111"),
		SpaceID:     parse("22222222-2222-4222-8222-222222222222"),
		EpisodeID:   parse("33333333-3333-4333-8333-333333333333"),
		RecordingID: parse("44444444-4444-4444-8444-444444444444"),
	}
}
