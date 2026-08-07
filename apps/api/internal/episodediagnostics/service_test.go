package episodediagnostics

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// repositoryStub embeds the production interface so focused service tests only
// need to provide the repository calls exercised by that test.
type repositoryStub struct {
	Repository

	resolveScopeFn       func(context.Context, AppendScope, int64) (EpisodeDiagnostic, error)
	appendFn             func(context.Context, EpisodeDiagnostic, *utilities.ID, []ValidatedEvent) (AppendDiagnosticEventsResult, error)
	resolveFn            func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error)
	resolveAlternateFn   func(context.Context, string, string, string) (DiagnosticReference, error)
	readSnapshotFn       func(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, int) (DiagnosticSnapshotV1, error)
	pageEventsFn         func(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, *int64, *int64, int) (DiagnosticEventPageV1, error)
	resolveScopeCall     int
	appendCall           int
	resolveCall          int
	resolveAlternateCall int
	readSnapshotCall     int
	pageEventsCall       int
}

type auditWriterStub struct {
	err   error
	calls []auditWrite
}

type auditWrite struct {
	diagnostic EpisodeDiagnostic
	operator   OperatorPrincipal
	capability string
	outcome    string
	errorCode  string
}

func (w *auditWriterStub) WriteDiagnosticAudit(_ context.Context, diagnostic EpisodeDiagnostic, operator OperatorPrincipal, capability, outcome, errorCode string) error {
	w.calls = append(w.calls, auditWrite{diagnostic: diagnostic, operator: operator, capability: capability, outcome: outcome, errorCode: errorCode})
	return w.err
}

func (r *repositoryStub) ResolveScope(ctx context.Context, scope AppendScope, generation int64) (EpisodeDiagnostic, error) {
	r.resolveScopeCall++
	if r.resolveScopeFn == nil {
		panic("unexpected ResolveScope call")
	}
	return r.resolveScopeFn(ctx, scope, generation)
}

func (r *repositoryStub) Append(ctx context.Context, diagnostic EpisodeDiagnostic, participantID *utilities.ID, events []ValidatedEvent) (AppendDiagnosticEventsResult, error) {
	r.appendCall++
	if r.appendFn == nil {
		panic("unexpected Append call")
	}
	return r.appendFn(ctx, diagnostic, participantID, events)
}

func (r *repositoryStub) Resolve(ctx context.Context, reference DiagnosticReference) (EpisodeDiagnostic, error) {
	r.resolveCall++
	if r.resolveFn == nil {
		panic("unexpected Resolve call")
	}
	return r.resolveFn(ctx, reference)
}

func (r *repositoryStub) ResolveAlternate(ctx context.Context, idClass, lookup, version string) (DiagnosticReference, error) {
	r.resolveAlternateCall++
	if r.resolveAlternateFn == nil {
		panic("unexpected ResolveAlternate call")
	}
	return r.resolveAlternateFn(ctx, idClass, lookup, version)
}

func (r *repositoryStub) ReadSnapshot(ctx context.Context, diagnostic EpisodeDiagnostic, filter DiagnosticFilterV1, limit int) (DiagnosticSnapshotV1, error) {
	r.readSnapshotCall++
	if r.readSnapshotFn == nil {
		panic("unexpected ReadSnapshot call")
	}
	return r.readSnapshotFn(ctx, diagnostic, filter, limit)
}

func (r *repositoryStub) PageEvents(ctx context.Context, diagnostic EpisodeDiagnostic, filter DiagnosticFilterV1, after, before *int64, limit int) (DiagnosticEventPageV1, error) {
	r.pageEventsCall++
	if r.pageEventsFn == nil {
		panic("unexpected PageEvents call")
	}
	return r.pageEventsFn(ctx, diagnostic, filter, after, before, limit)
}

func mustServiceID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test id %q: %v", value, err)
	}
	return id
}

func serviceDiagnosticFixture() EpisodeDiagnostic {
	return EpisodeDiagnostic{
		ID:          "diag01",
		TenantID:    "11111111-1111-4111-8111-111111111111",
		SpaceID:     "22222222-2222-4222-8222-222222222222",
		EpisodeID:   "33333333-3333-4333-8333-333333333333",
		Environment: EnvironmentDevelopment,
		State:       DiagnosticLive,
	}
}

func serviceOperator() OperatorPrincipal {
	return OperatorPrincipal{SubjectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Environment: EnvironmentDevelopment, Capabilities: map[string]struct{}{"read": {}}}
}

func serviceReference() string {
	return "chalkdiag:v1:development:diag01"
}

func TestServiceAppendBindsParticipantScopeAndDelegatesReceipt(t *testing.T) {
	tenantID := mustServiceID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustServiceID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustServiceID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustServiceID(t, "44444444-4444-4444-8444-444444444444")
	principal := ProducerPrincipal{
		Kind:                  ProducerParticipant,
		ID:                    "producer-01",
		InstanceID:            "instance-01",
		Generation:            3,
		Environment:           EnvironmentDevelopment,
		TenantID:              tenantID,
		SpaceID:               spaceID,
		EpisodeID:             episodeID,
		ParticipantID:         participantID,
		ParticipantGeneration: 9,
		AllowedSources:        map[EventSource]struct{}{SourceSDK: {}},
	}
	draft := draftFixture()
	want := AppendDiagnosticEventsResult{
		DiagnosticReference: "chalkdiag:v1:development:diag01",
		CommittedCursor:     12,
		Accepted:            []AppendEventReceipt{{EventID: draft.EventID, Cursor: 12}},
	}
	repository := &repositoryStub{
		resolveScopeFn: func(_ context.Context, scope AppendScope, generation int64) (EpisodeDiagnostic, error) {
			wantScope := AppendScope{TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String(), ParticipantID: participantID.String()}
			if !reflect.DeepEqual(scope, wantScope) {
				t.Fatalf("participant scope was not bound: got %+v want %+v", scope, wantScope)
			}
			if generation != principal.ParticipantGeneration {
				t.Fatalf("participant generation was not delegated: got %d want %d", generation, principal.ParticipantGeneration)
			}
			return serviceDiagnosticFixture(), nil
		},
		appendFn: func(_ context.Context, diagnostic EpisodeDiagnostic, gotParticipantID *utilities.ID, events []ValidatedEvent) (AppendDiagnosticEventsResult, error) {
			if diagnostic.ID != "diag01" {
				t.Fatalf("unexpected diagnostic: %+v", diagnostic)
			}
			if gotParticipantID == nil || *gotParticipantID != participantID {
				t.Fatalf("participant ID was not delegated: %v", gotParticipantID)
			}
			if len(events) != 1 || events[0].Event.EventID != draft.EventID {
				t.Fatalf("unexpected validated events: %+v", events)
			}
			if events[0].Fingerprint == "" || len(events[0].Canonical) == 0 {
				t.Fatal("append did not receive canonical validation metadata")
			}
			return want, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, &auditWriterStub{}, nil)
	request := AppendDiagnosticEventsRequest{
		Version:  1,
		Producer: ProducerIdentity{ID: principal.ID, InstanceID: principal.InstanceID, Generation: principal.Generation},
		Events:   []DiagnosticEventDraft{draft},
	}

	got, err := service.Append(context.Background(), principal, request)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("append receipt changed: got %+v want %+v", got, want)
	}
	if repository.resolveScopeCall != 1 || repository.appendCall != 1 {
		t.Fatalf("unexpected repository calls: resolve scope %d append %d", repository.resolveScopeCall, repository.appendCall)
	}
}

func TestServiceAppendRejectsParticipantScopeAndSourceMismatches(t *testing.T) {
	tenantID := mustServiceID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustServiceID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustServiceID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustServiceID(t, "44444444-4444-4444-8444-444444444444")
	principal := ProducerPrincipal{
		Kind:                  ProducerParticipant,
		ID:                    "producer-01",
		InstanceID:            "instance-01",
		Generation:            3,
		Environment:           EnvironmentDevelopment,
		TenantID:              tenantID,
		SpaceID:               spaceID,
		EpisodeID:             episodeID,
		ParticipantID:         participantID,
		ParticipantGeneration: 9,
		AllowedSources:        map[EventSource]struct{}{SourceSDK: {}},
	}
	baseRequest := AppendDiagnosticEventsRequest{
		Version:  1,
		Producer: ProducerIdentity{ID: principal.ID, InstanceID: principal.InstanceID, Generation: principal.Generation},
		Events:   []DiagnosticEventDraft{draftFixture()},
	}
	repository := &repositoryStub{
		resolveScopeFn: func(context.Context, AppendScope, int64) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, nil, nil)

	t.Run("scope override", func(t *testing.T) {
		request := baseRequest
		request.Scope = &AppendScope{TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String(), ParticipantID: "55555555-5555-4555-8555-555555555555"}
		_, err := service.Append(context.Background(), principal, request)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("scope override error = %v, want %v", err, ErrForbidden)
		}
	})

	t.Run("source not allowed", func(t *testing.T) {
		request := baseRequest
		event := draftFixture()
		event.EventID = "event-api"
		event.Source = SourceAPI
		request.Events = []DiagnosticEventDraft{event}
		_, err := service.Append(context.Background(), principal, request)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("source mismatch error = %v, want %v", err, ErrForbidden)
		}
	})
	if repository.appendCall != 0 {
		t.Fatalf("source mismatch reached append %d times", repository.appendCall)
	}
}

func TestServiceRejectsOperatorCapabilityOrEnvironmentMismatch(t *testing.T) {
	repository := &repositoryStub{
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			t.Fatal("repository resolve should not run for a forbidden operator")
			return EpisodeDiagnostic{}, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, nil, nil)
	tests := []struct {
		name     string
		operator OperatorPrincipal
	}{
		{name: "missing read capability", operator: OperatorPrincipal{SubjectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Environment: EnvironmentDevelopment, Capabilities: map[string]struct{}{}}},
		{name: "wrong environment", operator: OperatorPrincipal{SubjectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Environment: EnvironmentStaging, Capabilities: map[string]struct{}{"read": {}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := service.Snapshot(context.Background(), test.operator, serviceReference(), DiagnosticFilterV1{})
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("snapshot error = %v, want %v", err, ErrForbidden)
			}
		})
	}
	if repository.resolveCall != 0 {
		t.Fatalf("forbidden operator reached repository %d times", repository.resolveCall)
	}
}

func TestServiceRejectsCrossTenantOperatorAfterReferenceResolution(t *testing.T) {
	repository := &repositoryStub{
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, nil, nil)
	operator := serviceOperator()
	operator.TenantScopeRequired = true
	operator.AuthorizedTenantIDs = []string{"99999999-9999-4999-8999-999999999999"}

	_, err := service.Snapshot(context.Background(), operator, serviceReference(), DiagnosticFilterV1{})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant snapshot error = %v, want %v", err, ErrForbidden)
	}
	if repository.resolveCall != 1 {
		t.Fatalf("cross-tenant check must happen after resolution, resolve calls = %d", repository.resolveCall)
	}
}

func TestServiceRejectsCrossTenantAlternateReference(t *testing.T) {
	repository := &repositoryStub{
		resolveAlternateFn: func(context.Context, string, string, string) (DiagnosticReference, error) {
			return DiagnosticReference{Version: 1, Environment: EnvironmentDevelopment, DiagnosticID: "diag01"}, nil
		},
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, []byte("hmac-key"), nil, nil)
	operator := serviceOperator()
	operator.TenantScopeRequired = true
	operator.AuthorizedTenantIDs = []string{"99999999-9999-4999-8999-999999999999"}

	_, err := service.AlternateReference(context.Background(), operator, "chalk.request", "request01")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant alternate reference error = %v, want %v", err, ErrForbidden)
	}
	if repository.resolveCall != 1 || repository.resolveAlternateCall != 1 {
		t.Fatalf("alternate scope check calls = resolve %d, alternate %d", repository.resolveCall, repository.resolveAlternateCall)
	}
}

func TestServiceResolveFocusedEventUsesCursorWindow(t *testing.T) {
	const cursor int64 = 7
	accepted := acceptedFixture(t, draftFixture(), cursor)
	var gotAfter, gotBefore *int64
	repository := &repositoryStub{
		resolveFn: func(_ context.Context, reference DiagnosticReference) (EpisodeDiagnostic, error) {
			if reference.Focus == nil || reference.Focus.Kind != ReferenceFocusEvent || reference.Focus.ID != "event01" || reference.Cursor == nil || *reference.Cursor != cursor {
				t.Fatalf("unexpected parsed focus: %+v", reference)
			}
			return serviceDiagnosticFixture(), nil
		},
		readSnapshotFn: func(_ context.Context, _ EpisodeDiagnostic, _ DiagnosticFilterV1, limit int) (DiagnosticSnapshotV1, error) {
			if limit != MaxSnapshotOperations {
				t.Fatalf("snapshot limit = %d, want %d", limit, MaxSnapshotOperations)
			}
			return DiagnosticSnapshotV1{}, nil
		},
		pageEventsFn: func(_ context.Context, _ EpisodeDiagnostic, filter DiagnosticFilterV1, after, before *int64, limit int) (DiagnosticEventPageV1, error) {
			if filter != (DiagnosticFilterV1{}) {
				t.Fatalf("focused lookup unexpectedly applied filter: %+v", filter)
			}
			gotAfter, gotBefore = after, before
			if limit != 1 {
				t.Fatalf("focused lookup limit = %d, want 1", limit)
			}
			return DiagnosticEventPageV1{Events: []AcceptedDiagnosticEvent{accepted}}, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, &auditWriterStub{}, nil)
	operator := serviceOperator()
	response, err := service.Resolve(context.Background(), operator, "chalkdiag:v1:development:diag01:event:event01@7")
	if err != nil {
		t.Fatalf("resolve focused event: %v", err)
	}
	if response.Kind != "event" || response.Event == nil || response.Event.Cursor != cursor {
		t.Fatalf("unexpected focused event response: %+v", response)
	}
	if gotAfter == nil || *gotAfter != cursor-1 || gotBefore == nil || *gotBefore != cursor+1 {
		t.Fatalf("focused event cursor window = after %v before %v, want %d/%d", gotAfter, gotBefore, cursor-1, cursor+1)
	}
}

func storageIdentifierHMAC(key []byte, environment Environment, idClass, raw string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(string(environment) + "\x00" + idClass + "\x00" + raw))
	return "hmac:v1:" + hex.EncodeToString(mac.Sum(nil))
}

func TestServiceAppendHMACsProviderCorrelationBeforeRepository(t *testing.T) {
	key := []byte("diagnostic-test-hmac-key")
	rawProviderID := "provider-secret"
	principalID := mustServiceID(t, "44444444-4444-4444-8444-444444444444")
	principal := ProducerPrincipal{
		Kind:                  ProducerParticipant,
		ID:                    "producer-01",
		InstanceID:            "instance-01",
		Generation:            3,
		Environment:           EnvironmentDevelopment,
		TenantID:              mustServiceID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:               mustServiceID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:             mustServiceID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:         principalID,
		ParticipantGeneration: 9,
		AllowedSources:        map[EventSource]struct{}{SourceSDK: {}},
	}
	event := draftFixture()
	event.EventID = "event-provider"
	event.Correlation = &DiagnosticEventCorrelation{ProviderID: rawProviderID}
	repository := &repositoryStub{
		resolveScopeFn: func(context.Context, AppendScope, int64) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
		appendFn: func(_ context.Context, _ EpisodeDiagnostic, _ *utilities.ID, events []ValidatedEvent) (AppendDiagnosticEventsResult, error) {
			if len(events) != 1 || events[0].Event.Correlation == nil {
				t.Fatalf("provider correlation was dropped: %+v", events)
			}
			stored := events[0].Event.Correlation.ProviderID
			want := storageIdentifierHMAC(key, EnvironmentDevelopment, "provider", rawProviderID)
			if stored != want {
				t.Fatalf("repository saw provider identifier %q, want HMAC %q", stored, want)
			}
			if strings.Contains(stored, rawProviderID) {
				t.Fatalf("repository saw raw provider identifier in %q", stored)
			}
			return AppendDiagnosticEventsResult{}, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, key, &auditWriterStub{}, nil)
	request := AppendDiagnosticEventsRequest{Version: 1, Producer: ProducerIdentity{ID: principal.ID, InstanceID: principal.InstanceID, Generation: principal.Generation}, Events: []DiagnosticEventDraft{event}}
	if _, err := service.Append(context.Background(), principal, request); err != nil {
		t.Fatalf("append provider correlation: %v", err)
	}
	if event.Correlation == nil || event.Correlation.ProviderID != rawProviderID {
		t.Fatalf("append mutated caller's provider identifier: %+v", event.Correlation)
	}
}

func TestServiceHostedReadFailsClosedWhenAuditIsUnavailable(t *testing.T) {
	for _, test := range []struct {
		name   string
		audits AuditWriter
	}{
		{name: "missing writer"},
		{name: "write failure", audits: &auditWriterStub{err: errors.New("audit database unavailable")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &repositoryStub{
				resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
					return serviceDiagnosticFixture(), nil
				},
				readSnapshotFn: func(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, int) (DiagnosticSnapshotV1, error) {
					t.Fatal("read proceeded after audit failure")
					return DiagnosticSnapshotV1{}, nil
				},
			}
			service := NewService(repository, EnvironmentDevelopment, nil, test.audits, nil)
			if _, err := service.Snapshot(context.Background(), serviceOperator(), serviceReference(), DiagnosticFilterV1{}); !errors.Is(err, ErrAuditUnavailable) {
				t.Fatalf("snapshot error = %v, want %v", err, ErrAuditUnavailable)
			}
			if repository.readSnapshotCall != 0 {
				t.Fatalf("snapshot repository read calls = %d, want 0", repository.readSnapshotCall)
			}
		})
	}
}

func TestServiceAlternateReferenceAuditsSuccessfulHostedRead(t *testing.T) {
	audits := &auditWriterStub{}
	repository := &repositoryStub{
		resolveAlternateFn: func(_ context.Context, idClass, lookup, version string) (DiagnosticReference, error) {
			if idClass != "chalk.request" || lookup != "request-01" || version != "" {
				t.Fatalf("alternate lookup = %s/%s/%s", idClass, lookup, version)
			}
			return DiagnosticReference{Version: 1, Environment: EnvironmentDevelopment, DiagnosticID: "diag01"}, nil
		},
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, audits, nil)
	reference, err := service.AlternateReference(context.Background(), serviceOperator(), "chalk.request", "request-01")
	if err != nil || reference.DiagnosticID != "diag01" {
		t.Fatalf("alternate reference = %+v, err=%v", reference, err)
	}
	if len(audits.calls) != 1 || audits.calls[0].capability != "read" || audits.calls[0].outcome != "success" || audits.calls[0].operator.SubjectHash != serviceOperator().SubjectHash {
		t.Fatalf("audit calls = %#v, want one successful read", audits.calls)
	}
}

func TestServiceAlternateReferenceFailsClosedWhenAuditWriteFails(t *testing.T) {
	repository := &repositoryStub{
		resolveAlternateFn: func(context.Context, string, string, string) (DiagnosticReference, error) {
			return DiagnosticReference{Version: 1, Environment: EnvironmentDevelopment, DiagnosticID: "diag01"}, nil
		},
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, &auditWriterStub{err: errors.New("audit database unavailable")}, nil)
	if _, err := service.AlternateReference(context.Background(), serviceOperator(), "chalk.command", "command-01"); !errors.Is(err, ErrAuditUnavailable) {
		t.Fatalf("alternate error = %v, want %v", err, ErrAuditUnavailable)
	}
}

func TestServiceEventsHMACsProviderFilterAndReturnsRawFingerprint(t *testing.T) {
	key := []byte("diagnostic-test-hmac-key")
	rawFilter := DiagnosticFilterV1{ProviderID: "provider-secret"}
	var storedFilter DiagnosticFilterV1
	repository := &repositoryStub{
		resolveFn: func(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
		pageEventsFn: func(_ context.Context, _ EpisodeDiagnostic, filter DiagnosticFilterV1, _, _ *int64, limit int) (DiagnosticEventPageV1, error) {
			storedFilter = filter
			if limit != DefaultPageSize {
				t.Fatalf("default event page limit = %d, want %d", limit, DefaultPageSize)
			}
			return DiagnosticEventPageV1{FilterFingerprint: "storage-fingerprint"}, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, key, &auditWriterStub{}, nil)
	page, err := service.Events(context.Background(), serviceOperator(), serviceReference(), rawFilter, nil, nil, 0)
	if err != nil {
		t.Fatalf("events with provider filter: %v", err)
	}
	wantStored := storageIdentifierHMAC(key, EnvironmentDevelopment, "provider", rawFilter.ProviderID)
	if storedFilter.ProviderID != wantStored {
		t.Fatalf("repository saw provider filter %q, want HMAC %q", storedFilter.ProviderID, wantStored)
	}
	if strings.Contains(storedFilter.ProviderID, rawFilter.ProviderID) {
		t.Fatalf("repository saw raw provider filter in %q", storedFilter.ProviderID)
	}
	if page.FilterFingerprint != FilterFingerprint(rawFilter) {
		t.Fatalf("returned filter fingerprint = %q, want raw-filter fingerprint %q", page.FilterFingerprint, FilterFingerprint(rawFilter))
	}
}

func TestProviderIdentifierProjectionIsNonCopyable(t *testing.T) {
	event := draftFixture()
	event.Correlation = &DiagnosticEventCorrelation{ProviderID: "hmac:v1:opaque"}
	accepted := acceptedFixture(t, event, 1)
	state := NewProjectionState(EpisodeDiagnostic{ID: "diag01", Environment: EnvironmentDevelopment, State: DiagnosticLive})
	if err := state.Reduce([]AcceptedDiagnosticEvent{accepted}); err != nil {
		t.Fatalf("reduce provider event: %v", err)
	}
	operation, ok := state.Operations[state.OperationRefs[event.ProducerOperationRef]]
	if !ok {
		t.Fatalf("provider event did not create operation: %+v", state.OperationRefs)
	}
	identifier, ok := operation.ProviderID.(SafeIdentifier)
	if !ok {
		t.Fatalf("provider identifier type = %T, want SafeIdentifier", operation.ProviderID)
	}
	if identifier.Value != "" || identifier.Copyable || identifier.UnknownReason != UnknownProviderOpaque {
		t.Fatalf("provider identifier was not opaque/non-copyable: %+v", identifier)
	}
	if operation.ProviderLookupID != event.Correlation.ProviderID {
		t.Fatalf("provider lookup token = %q, want stored HMAC token %q", operation.ProviderLookupID, event.Correlation.ProviderID)
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), event.Correlation.ProviderID) || strings.Contains(string(encoded), "ProviderLookupID") {
		t.Fatalf("public operation exposed provider lookup token: %s", encoded)
	}
}
