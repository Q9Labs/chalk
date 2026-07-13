package sessionlifecycle_test

import (
	"context"
	"encoding/hex"
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
		Metadata: []byte(`{"topic":"planning","settings":{"b":2,"a":1}}`), StartedAt: &startedAt,
		Request: sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	setValidPolicy(&input)
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

func TestServiceCreateFingerprintIncludesEveryPolicyInput(t *testing.T) {
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
		Request:         sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	setValidPolicy(&input)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatalf("create session: %v", err)
	}

	changedControl := input
	changedControl.InitialControl = sessionlifecycle.InitialControlState{
		FoldedState:   []byte(`{"control_revision":7,"future_default":true}`),
		Digest:        [32]byte{1},
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
		t.Fatal("derived InitialControl values changed the create fingerprint")
	}
	for _, index := range []int{2, 3, 4} {
		if repository.creates[index].Request.Fingerprint == original {
			t.Fatalf("semantic create input %d produced the original fingerprint", index)
		}
	}
	policyChanges := []sessionlifecycle.CreateSessionInput{input, input, input, input}
	policyChanges[0].AdmissionPolicy = "closed"
	policyChanges[1].HostExitPolicy = "promote_cohost"
	policyChanges[2].RoleCapabilities = cloneRoleCapabilities(input.RoleCapabilities)
	policyChanges[2].RoleCapabilities["participant"] = []string{"publishAudio", "subscribe"}
	policyChanges[3].MaximumDurationSeconds--
	for index := range policyChanges {
		if _, err := service.CreateSession(context.Background(), policyChanges[index]); err != nil {
			t.Fatalf("policy change %d: %v", index, err)
		}
		if repository.creates[5+index].Request.Fingerprint == original {
			t.Fatalf("policy change %d produced the original fingerprint", index)
		}
	}
	derivedChanges := []sessionlifecycle.CreateSessionInput{input, input}
	derivedChanges[0].MaximumDurationCeilingSeconds++
	derivedChanges[1].DeadlineAt = derivedChanges[1].DeadlineAt.Add(time.Second)
	for index := range derivedChanges {
		if _, err := service.CreateSession(context.Background(), derivedChanges[index]); err != nil {
			t.Fatalf("derived policy change %d: %v", index, err)
		}
		if repository.creates[9+index].Request.Fingerprint != original {
			t.Fatalf("server-derived policy change %d changed the public request fingerprint", index)
		}
	}
}

func TestServiceCanonicalizesPolicyAndEligibleRoleSets(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	input := sessionlifecycle.CreateSessionInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		Request: sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	setValidPolicy(&input)
	if _, err := service.CreateSession(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	reordered := input
	reordered.RoleCapabilities = cloneRoleCapabilities(input.RoleCapabilities)
	reordered.RoleCapabilities["host"] = []string{"endMeeting", "transferHost", "subscribe", "publishAudio"}
	reordered.RoleCapabilities["cohost"] = []string{"subscribe", "publishAudio"}
	if _, err := service.CreateSession(context.Background(), reordered); err != nil {
		t.Fatal(err)
	}
	if repository.creates[0].Request.Fingerprint != repository.creates[1].Request.Fingerprint || repository.creates[0].InitialControl.Digest != repository.creates[1].InitialControl.Digest {
		t.Fatal("reordered capability sets changed the fingerprint or initial digest")
	}
	if got := repository.creates[1].RoleCapabilities["host"]; len(got) != 4 || got[0] != "publishAudio" || got[3] != "endMeeting" {
		t.Fatalf("canonical host capabilities = %#v", got)
	}

	admission := sessionlifecycle.AdmitParticipantInput{
		TenantID: input.TenantID, RoomID: input.RoomID, SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"), Name: "Ada",
		InitialRole: "host", EligibleRoles: []string{"participant", "cohost", "host"}, Request: sessionlifecycle.Request{Key: "admit-request-key-0001"},
	}
	if _, err := service.AdmitParticipant(context.Background(), admission); err != nil {
		t.Fatal(err)
	}
	admission.EligibleRoles = []string{"host", "cohost", "participant"}
	if _, err := service.AdmitParticipant(context.Background(), admission); err != nil {
		t.Fatal(err)
	}
	if repository.admissions[0].Request.Fingerprint != repository.admissions[1].Request.Fingerprint {
		t.Fatal("reordered eligible-role sets changed the admission fingerprint")
	}
	if got := repository.admissions[0].EligibleRoles; len(got) != 3 || got[0] != "host" || got[1] != "cohost" || got[2] != "participant" {
		t.Fatalf("canonical eligible roles = %#v", got)
	}
}

func TestServiceCreateFingerprintCanonicalizesExactJSONNumbers(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	input := sessionlifecycle.CreateSessionInput{
		TenantID:        mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:          mustID(t, "22222222-2222-4222-8222-222222222222"),
		CreatedByUserID: mustID(t, "33333333-3333-4333-8333-333333333333"),
		Request:         sessionlifecycle.Request{Key: "create-request-key-0001"},
	}
	setValidPolicy(&input)

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

type captureControlRepository struct {
	*captureRepository
	transfers []sessionlifecycle.TransferHostInput
	deadlines []sessionlifecycle.SetDeadlineInput
}

func (r *captureControlRepository) TransferHost(_ context.Context, input sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error) {
	r.transfers = append(r.transfers, input)
	return sessionlifecycle.ControlRequest{}, nil
}

func (r *captureControlRepository) SetDeadline(_ context.Context, input sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error) {
	r.deadlines = append(r.deadlines, input)
	return sessionlifecycle.ControlRequest{}, nil
}

func TestServiceDerivesStableTenantControlFingerprints(t *testing.T) {
	repository := &captureControlRepository{captureRepository: &captureRepository{}}
	service := sessionlifecycle.NewService(repository)
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustID(t, "44444444-4444-4444-8444-444444444444")
	transfer := sessionlifecycle.TransferHostInput{
		TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID,
		ParticipantGeneration: 3, Request: sessionlifecycle.Request{Key: "tenant-transfer-key-0001"},
	}
	if _, err := service.TransferHost(context.Background(), transfer); err != nil {
		t.Fatalf("transfer host: %v", err)
	}
	if _, err := service.TransferHost(context.Background(), transfer); err != nil {
		t.Fatalf("retry transfer host: %v", err)
	}
	if repository.transfers[0].Request.Fingerprint != repository.transfers[1].Request.Fingerprint || string(repository.transfers[0].Request.Payload()) != `{"participantSessionId":"44444444-4444-4444-8444-444444444444"}` {
		t.Fatalf("transfer fingerprints or payloads are unstable: %#v", repository.transfers)
	}
	deadline := sessionlifecycle.SetDeadlineInput{
		TenantID: tenantID, RoomID: roomID, SessionID: sessionID,
		Deadline: time.Date(2026, 7, 13, 7, 0, 0, 123456789, time.UTC), Request: sessionlifecycle.Request{Key: "tenant-deadline-key-0001"},
	}
	if _, err := service.SetDeadline(context.Background(), deadline); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if repository.deadlines[0].Deadline.Nanosecond() != 123000000 || repository.deadlines[0].Request.Fingerprint == ([32]byte{}) {
		t.Fatalf("normalized deadline = %#v", repository.deadlines[0])
	}
}

func TestServiceDerivesLifecycleFingerprintFromNormalizedSemanticInput(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	input := sessionlifecycle.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		Name: " Ada ", Metadata: []byte(`{"role":"editor"}`), InitialRole: "participant", EligibleRoles: []string{"participant"},
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
	if got := string(repository.admissions[0].Request.Payload()); got != `{"display_name":"Ada","participant_session_id":"44444444-4444-4444-8444-444444444444","initial_role":"participant","eligible_roles":["participant"]}` {
		t.Fatalf("admission payload = %s", got)
	}
	changedEnvelope := input
	changedEnvelope.InitialRole = "cohost"
	changedEnvelope.EligibleRoles = []string{"cohost", "participant"}
	if _, err := service.AdmitParticipant(context.Background(), changedEnvelope); err != nil {
		t.Fatalf("changed authority envelope: %v", err)
	}
	if repository.admissions[3].Request.Fingerprint == repository.admissions[0].Request.Fingerprint {
		t.Fatal("changed authority envelope produced the original fingerprint")
	}
}

func TestServiceRejectsInvalidLifecycleRequestKeysBeforeRepository(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	base := sessionlifecycle.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"), Name: "Ada",
		InitialRole: "participant", EligibleRoles: []string{"participant"},
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

func TestNewInitialControlStateEncodesExactEmptyV3Projection(t *testing.T) {
	input := sessionlifecycle.CreateSessionInput{}
	setValidPolicy(&input)
	state, err := sessionlifecycle.NewInitialControlState(sessionlifecycle.InitialControlPolicy{
		AdmissionPolicy: input.AdmissionPolicy, HostExitPolicy: input.HostExitPolicy,
		RoleCapabilities: input.RoleCapabilities, MaximumDurationSeconds: input.MaximumDurationSeconds,
		MaximumDurationCeilingSeconds: input.MaximumDurationCeilingSeconds, DeadlineAt: input.DeadlineAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantProjection := `{"admission_policy":"open","admission_requests":[],"control_revision":0,"deadline_at_ms":1783944000000,"deadline_generation":1,"host_exit_policy":"require_transfer","host_participant_session_id":null,"participants":[],"recording":null,"role_capabilities":{"cohost":["publishAudio","subscribe"],"host":["publishAudio","subscribe","transferHost","endMeeting"],"participant":["subscribe"]},"state_schema_version":3,"status":"active"}`
	if string(state.FoldedState) != wantProjection {
		t.Fatalf("folded state = %s", state.FoldedState)
	}
	if state.SchemaVersion != 3 {
		t.Fatalf("schema version = %d, want 3", state.SchemaVersion)
	}
	if got := hex.EncodeToString(state.Digest[:]); got != "cff2faec6a97d9f9064cf2995d7d003e3430f39c12f72afddc4b1644fc78dd0d" {
		t.Fatalf("digest = %s", got)
	}
	if state.SnapshotBytes != int64(len(wantProjection)+82) {
		t.Fatalf("snapshot bytes = %d", state.SnapshotBytes)
	}
}

func TestNewInitialControlStateRejectsInvalidBoundedPolicy(t *testing.T) {
	input := sessionlifecycle.CreateSessionInput{}
	setValidPolicy(&input)
	base := sessionlifecycle.InitialControlPolicy{
		AdmissionPolicy: input.AdmissionPolicy, HostExitPolicy: input.HostExitPolicy,
		RoleCapabilities: input.RoleCapabilities, MaximumDurationSeconds: input.MaximumDurationSeconds,
		MaximumDurationCeilingSeconds: input.MaximumDurationCeilingSeconds, DeadlineAt: input.DeadlineAt,
	}
	tests := []struct {
		name   string
		change func(*sessionlifecycle.InitialControlPolicy)
		want   error
	}{
		{name: "admission", change: func(policy *sessionlifecycle.InitialControlPolicy) { policy.AdmissionPolicy = "invite" }, want: sessionlifecycle.ErrInvalidAdmissionPolicy},
		{name: "host exit", change: func(policy *sessionlifecycle.InitialControlPolicy) { policy.HostExitPolicy = "end" }, want: sessionlifecycle.ErrInvalidHostExitPolicy},
		{name: "unknown capability", change: func(policy *sessionlifecycle.InitialControlPolicy) {
			policy.RoleCapabilities = cloneRoleCapabilities(policy.RoleCapabilities)
			policy.RoleCapabilities["host"] = append(policy.RoleCapabilities["host"], "admin")
		}, want: sessionlifecycle.ErrInvalidRoleCapabilities},
		{name: "duration below minimum", change: func(policy *sessionlifecycle.InitialControlPolicy) {
			policy.MaximumDurationSeconds = sessionlifecycle.MinimumSessionDurationSeconds - 1
		}, want: sessionlifecycle.ErrInvalidMaximumDuration},
		{name: "duration over ceiling", change: func(policy *sessionlifecycle.InitialControlPolicy) {
			policy.MaximumDurationSeconds = policy.MaximumDurationCeilingSeconds + 1
		}, want: sessionlifecycle.ErrInvalidMaximumDurationCeiling},
		{name: "ceiling above public maximum", change: func(policy *sessionlifecycle.InitialControlPolicy) {
			policy.MaximumDurationCeilingSeconds = sessionlifecycle.MaximumSessionDurationSeconds + 1
		}, want: sessionlifecycle.ErrInvalidMaximumDurationCeiling},
		{name: "deadline", change: func(policy *sessionlifecycle.InitialControlPolicy) { policy.DeadlineAt = time.Time{} }, want: sessionlifecycle.ErrInvalidDeadline},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy := base
			test.change(&policy)
			if _, err := sessionlifecycle.NewInitialControlState(policy); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestServiceRejectsMalformedParticipantAuthorityEnvelope(t *testing.T) {
	repository := &captureRepository{}
	service := sessionlifecycle.NewService(repository)
	base := sessionlifecycle.AdmitParticipantInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"), RoomID: mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID: mustID(t, "33333333-3333-4333-8333-333333333333"), ParticipantID: mustID(t, "44444444-4444-4444-8444-444444444444"),
		Name: "Ada", InitialRole: "host", EligibleRoles: []string{"host", "cohost"}, Request: sessionlifecycle.Request{Key: "admit-request-key-0001"},
	}
	tests := []struct {
		name     string
		role     string
		eligible []string
		want     error
	}{
		{name: "unknown initial", role: "moderator", eligible: []string{"participant"}, want: sessionlifecycle.ErrInvalidInitialRole},
		{name: "missing initial", role: "cohost", eligible: []string{"participant"}, want: sessionlifecycle.ErrInvalidEligibleRoles},
		{name: "duplicate", role: "participant", eligible: []string{"participant", "participant"}, want: sessionlifecycle.ErrInvalidEligibleRoles},
		{name: "host without cohost", role: "host", eligible: []string{"host"}, want: sessionlifecycle.ErrInvalidEligibleRoles},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := base
			input.InitialRole = test.role
			input.EligibleRoles = test.eligible
			if _, err := service.AdmitParticipant(context.Background(), input); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func setValidPolicy(input *sessionlifecycle.CreateSessionInput) {
	input.AdmissionPolicy = "open"
	input.HostExitPolicy = "require_transfer"
	input.RoleCapabilities = map[string][]string{
		"host":        {"publishAudio", "subscribe", "transferHost", "endMeeting"},
		"cohost":      {"publishAudio", "subscribe"},
		"participant": {"subscribe"},
	}
	input.MaximumDurationSeconds = 3600
	input.MaximumDurationCeilingSeconds = 7200
	input.DeadlineAt = time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
}

func cloneRoleCapabilities(input map[string][]string) map[string][]string {
	result := make(map[string][]string, len(input))
	for role, capabilities := range input {
		result[role] = append([]string(nil), capabilities...)
	}
	return result
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
