package sessionlifecycle_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type captureRepository struct {
	admissions []sessionlifecycle.AdmitParticipantInput
	creates    []sessionlifecycle.CreateSessionInput
}

func (r *captureRepository) CreateSession(_ context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	r.creates = append(r.creates, input)
	return sessionlifecycle.Session{ID: input.ID}, nil
}

func TestServiceDerivesSessionCreateFingerprintWithoutGeneratedID(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	startedAt := time.Date(2026, 7, 12, 12, 0, 0, 0, time.FixedZone("offset", 5*60*60))
	input := sessionlifecycle.CreateSessionInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		Metadata: []byte(`{"topic":"planning","settings":{"b":2,"a":1}}`), StartedAt: &startedAt, InitialControl: sessionlifecycle.EmptyInitialControlState(),
		Request: sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("first create: %v", err)
	}
	input.Metadata = []byte(`{ "settings": { "a": 1, "b": 2 }, "topic": "planning" }`)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("retry create: %v", err)
	}
	changed := input
	changed.Metadata = []byte(`{"topic":"different"}`)
	if _, err := service.CreateSession(context.Background(), changed); err != nil {
		t.Fatalf("changed create: %v", err)
	}

	if repository.creates[0].ID == repository.creates[1].ID {
		t.Fatal("service reused generated session ID")
	}
	if repository.creates[0].Request.Fingerprint != repository.creates[1].Request.Fingerprint {
		t.Fatal("semantic retries produced different fingerprints")
	}
	if repository.creates[0].Request.Fingerprint == repository.creates[2].Request.Fingerprint {
		t.Fatal("different create input produced the same fingerprint")
	}
}

func TestServiceCreateFingerprintExcludesServerControlDefaults(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	startedAt := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	actorID := mustID(t, "33333333-3333-4333-8333-333333333333")
	input := sessionlifecycle.CreateSessionInput{
		TenantID:        mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
		Metadata:        []byte(`{"topic":"planning"}`),
		CreatedByUserID: actorID,
		StartedAt:       &startedAt,
		InitialControl:  sessionlifecycle.EmptyInitialControlState(),
		Request:         sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("create session: %v", err)
	}

	changedControl := input
	changedControl.InitialControl = sessionlifecycle.InitialControlState{
		FoldedState:   []byte(`{"control_revision":7,"future_default":true}`),
		Digest:        sha256.Sum256([]byte("different control digest")),
		SchemaVersion: 2,
		SnapshotBytes: 777,
	}
	if _, err := service.CreateSession(context.Background(), changedControl); err != nil {
		t.Fatalf("retry after control default change: %v", err)
	}

	changedMetadata := input
	changedMetadata.Metadata = []byte(`{"topic":"different"}`)
	if _, err := service.CreateSession(context.Background(), changedMetadata); err != nil {
		t.Fatalf("changed metadata create: %v", err)
	}
	changedActor := input
	changedActor.CreatedByUserID = mustID(t, "44444444-4444-4444-8444-444444444444")
	if _, err := service.CreateSession(context.Background(), changedActor); err != nil {
		t.Fatalf("changed actor create: %v", err)
	}
	changedStartedAt := input
	later := startedAt.Add(time.Minute)
	changedStartedAt.StartedAt = &later
	if _, err := service.CreateSession(context.Background(), changedStartedAt); err != nil {
		t.Fatalf("changed started_at create: %v", err)
	}

	original := repository.creates[0].Request.Fingerprint
	if repository.creates[1].Request.Fingerprint != original {
		t.Fatal("server-owned InitialControl values changed the create fingerprint")
	}
	for _, index := range []int{2, 3, 4} {
		if repository.creates[index].Request.Fingerprint == original {
			t.Fatalf("semantic create input %d produced the original fingerprint", index)
		}
	}
}

func TestServiceCreateFingerprintCanonicalizesExactJSONNumbers(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	input := sessionlifecycle.CreateSessionInput{
		TenantID:        mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
		CreatedByUserID: mustID(t, "33333333-3333-4333-8333-333333333333"),
		InitialControl:  sessionlifecycle.EmptyInitialControlState(),
		Request:         sessionlifecycle.Request{Key: "create-request-key-0001"},
	}

	input.Metadata = []byte(`{"z":{"huge":123456789012345678901234567890.0,"nested":[1,1.0,1e0,0.0100,100e-4]},"a":1}`)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("first numeric create: %v", err)
	}
	input.Metadata = []byte(`{"a":1.0,"z":{"nested":[1e0,1.000,1.0,1e-2,1.00e-2],"huge":123456789012345678901234567890e0}}`)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("equivalent numeric create: %v", err)
	}
	input.Metadata = []byte(`{"a":1,"z":{"huge":123456789012345678901234567891,"nested":[1,1,1,0.01,0.01]}}`)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("distinct numeric create: %v", err)
	}

	if repository.creates[0].Request.Fingerprint != repository.creates[1].Request.Fingerprint {
		t.Fatal("equivalent numeric JSON values produced different create fingerprints")
	}
	if repository.creates[0].Request.Fingerprint == repository.creates[2].Request.Fingerprint {
		t.Fatal("distinct exact JSON numbers produced the same create fingerprint")
	}
}

func (r *captureRepository) AdmitParticipant(_ context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	r.admissions = append(r.admissions, input)
	return sessionlifecycle.Admission{}, nil
}

func (r *captureRepository) RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	return sessionlifecycle.Removal{}, errors.New("unexpected remove participant")
}

func (r *captureRepository) RequestSessionEnd(context.Context, sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	return sessionlifecycle.EndRequest{}, errors.New("unexpected end session")
}

func TestServiceDerivesLifecycleFingerprintFromNormalizedSemanticInput(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	input := sessionlifecycle.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		Name: " Ada ", Metadata: []byte(`{"role":"editor"}`), Capabilities: []string{"control"},
		Request: sessionlifecycle.Request{Key: "admit-request-key-0001"},
	}

	if _, err := service.AdmitParticipant(context.Background(), input); err != nil {
		t.Fatalf("first admission: %v", err)
	}
	if _, err := service.AdmitParticipant(context.Background(), input); err != nil {
		t.Fatalf("retry admission: %v", err)
	}
	changed := input
	changed.Name = "Grace"
	if _, err := service.AdmitParticipant(context.Background(), changed); err != nil {
		t.Fatalf("changed admission: %v", err)
	}

	if repository.admissions[0].Request.Fingerprint == ([32]byte{}) {
		t.Fatal("derived fingerprint is empty")
	}
	if repository.admissions[0].Request.Fingerprint != repository.admissions[1].Request.Fingerprint {
		t.Fatal("identical normalized requests produced different fingerprints")
	}
	if repository.admissions[0].Request.Fingerprint == repository.admissions[2].Request.Fingerprint {
		t.Fatal("different semantic requests produced the same fingerprint")
	}
	if repository.admissions[0].Name != "Ada" {
		t.Fatalf("normalized name = %q, want Ada", repository.admissions[0].Name)
	}
}

func TestServiceRejectsInvalidLifecycleRequestKeysBeforeRepository(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	base := sessionlifecycle.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"), Name: "Ada",
	}
	for _, key := range []string{"short", "123456789012345é", "123456789012345!"} {
		input := base
		input.Request.Key = key
		if _, err := service.AdmitParticipant(context.Background(), input); !errors.Is(err, sessionlifecycle.ErrInvalidRequestKey) {
			t.Fatalf("key %q error = %v, want invalid request key", key, err)
		}
	}
	if len(repository.admissions) != 0 {
		t.Fatalf("repository admissions = %d, want zero", len(repository.admissions))
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
