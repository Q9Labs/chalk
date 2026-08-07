package episodediagnostics

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrDisabled         = errors.New("episode diagnostics are disabled")
	ErrUnauthenticated  = errors.New("diagnostic principal is unauthenticated")
	ErrForbidden        = errors.New("diagnostic principal is forbidden")
	ErrNotFound         = errors.New("episode diagnostic not found")
	ErrConflict         = errors.New("diagnostic event fingerprint conflict")
	ErrCapacity         = errors.New("diagnostic capacity exceeded")
	ErrInvalidScope     = errors.New("invalid diagnostic scope")
	ErrInvalidReference = errors.New("invalid diagnostic reference")
	ErrExportNotFound   = errors.New("diagnostic export job not found")
	ErrExportQuota      = errors.New("diagnostic export quota exceeded")
	ErrExportNotReady   = errors.New("diagnostic export is not ready")
	ErrSlowConsumer     = errors.New("diagnostic stream consumer is too slow")
	ErrAuditUnavailable = errors.New("diagnostic access audit is unavailable")
)

const (
	MaxAppendEvents       = 200
	MaxSnapshotOperations = 500
	MaxSnapshotIssues     = 500
	MaxSnapshotBranches   = 100
	DefaultPageSize       = 100
	MaxActiveExports      = 2
	MaxOperatorTenantIDs  = 128
	RetentionPeriod       = 7 * 24 * time.Hour
	MaximumEpilogueLease  = 24 * time.Hour
	ExportLease           = 30 * time.Minute
	ExportDownloadLife    = time.Hour
)

type ProducerKind string

const (
	ProducerParticipant ProducerKind = "participant"
	ProducerService     ProducerKind = "service"
)

type ProducerPrincipal struct {
	Kind                  ProducerKind
	ID                    string
	ServiceID             string
	InstanceID            string
	Generation            int64
	Environment           Environment
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	AllowedSources        map[EventSource]struct{}
}

type OperatorPrincipal struct {
	SubjectHash         string
	Environment         Environment
	Capabilities        map[string]struct{}
	AuthorizedTenantIDs []string
	TenantScopeRequired bool
}

func (p OperatorPrincipal) Can(capability string) bool {
	_, ok := p.Capabilities[capability]
	return ok
}

type AuthoritativeEpisode struct {
	Episode     episodes.Episode
	StartedLate bool
}

type ProjectionChange struct {
	Cursor  int64
	Ordinal int
	Kind    StreamDeltaKind
	Payload json.RawMessage
}

type ExportArtifact struct {
	ContentType string
	ObjectKey   string
	Size        int64
	Checksum    string
	Data        []byte
}

type Repository interface {
	Ensure(context.Context, AuthoritativeEpisode, Environment) (EpisodeDiagnostic, error)
	Reconcile(context.Context, Environment, time.Time, int) ([]EpisodeDiagnostic, error)
	ResolveScope(context.Context, AppendScope, int64) (EpisodeDiagnostic, error)
	Append(context.Context, EpisodeDiagnostic, *utilities.ID, []ValidatedEvent) (AppendDiagnosticEventsResult, error)
	Resolve(context.Context, DiagnosticReference) (EpisodeDiagnostic, error)
	ResolveAlternate(context.Context, string, string, string) (DiagnosticReference, error)
	ReadSnapshot(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, int) (DiagnosticSnapshotV1, error)
	PageEvents(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, *int64, *int64, int) (DiagnosticEventPageV1, error)
	PageOperations(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, *int64, int) (DiagnosticOperationPageV1, error)
	ListProjectionChanges(context.Context, EpisodeDiagnostic, int64, int) ([]ProjectionChange, error)
	Project(context.Context, string, int) (int, error)
	ScanDeadlines(context.Context, time.Time, int) (int, error)
	CreateExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, int64, *int64, time.Time) (DiagnosticExportJob, error)
	GetExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID) (DiagnosticExportJob, error)
	CancelExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID, time.Time) (DiagnosticExportJob, error)
	ExportArtifact(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID) (ExportArtifact, error)
	RunExport(context.Context, string) (bool, error)
	Retain(context.Context, time.Time, int) (int, error)
}

type AuditWriter interface {
	WriteDiagnosticAudit(context.Context, EpisodeDiagnostic, OperatorPrincipal, string, string, string) error
}

type Telemetry interface {
	RecordDiagnostic(context.Context, string, string, string, time.Duration)
}

type Service struct {
	repository  Repository
	audits      AuditWriter
	telemetry   Telemetry
	environment Environment
	hmacKey     []byte
	now         func() time.Time
}

func NewService(repository Repository, environment Environment, hmacKey []byte, audits AuditWriter, telemetry Telemetry) Service {
	return Service{repository: repository, environment: environment, hmacKey: append([]byte(nil), hmacKey...), audits: audits, telemetry: telemetry, now: time.Now}
}

func (s Service) Ensure(ctx context.Context, episode episodes.Episode, startedLate bool) (EpisodeDiagnostic, error) {
	if s.repository == nil {
		return EpisodeDiagnostic{}, ErrDisabled
	}
	diagnostic, err := s.repository.Ensure(ctx, AuthoritativeEpisode{Episode: episode, StartedLate: startedLate}, s.environment)
	if err != nil {
		return EpisodeDiagnostic{}, err
	}
	if err := validateEnvironment(s.environment, diagnostic.Environment); err != nil {
		return EpisodeDiagnostic{}, err
	}
	return sanitizeDiagnosticConfig(diagnostic), nil
}

func (s Service) Append(ctx context.Context, principal ProducerPrincipal, request AppendDiagnosticEventsRequest) (AppendDiagnosticEventsResult, error) {
	started := s.now()
	if s.repository == nil {
		return AppendDiagnosticEventsResult{}, ErrDisabled
	}
	if len(request.Events) > MaxAppendEvents {
		s.record(ctx, "append", "rejected", "capacity", started)
		return AppendDiagnosticEventsResult{}, ErrCapacity
	}
	if err := ValidateAppendRequest(request); err != nil {
		s.record(ctx, "append", "rejected", "invalid", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := authorizeProducer(principal, request); err != nil {
		s.record(ctx, "append", "rejected", "forbidden", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := validateEnvironment(principal.Environment, s.environment); err != nil {
		s.record(ctx, "append", "rejected", "environment", started)
		return AppendDiagnosticEventsResult{}, err
	}
	scope, participantID, err := boundScope(principal, request.Scope)
	if err != nil {
		return AppendDiagnosticEventsResult{}, err
	}
	validated := make([]ValidatedEvent, 0, len(request.Events))
	for _, event := range request.Events {
		if _, ok := principal.AllowedSources[event.Source]; !ok {
			return AppendDiagnosticEventsResult{}, ErrForbidden
		}
		event, err = s.eventForStorage(event)
		if err != nil {
			return AppendDiagnosticEventsResult{}, err
		}
		item, validateErr := ValidateDraft(event)
		if validateErr != nil {
			return AppendDiagnosticEventsResult{}, validateErr
		}
		validated = append(validated, item)
	}
	diagnostic, err := s.repository.ResolveScope(ctx, scope, principal.ParticipantGeneration)
	if err != nil {
		return AppendDiagnosticEventsResult{}, err
	}
	if err := ValidateProducerEnvironment(principal, diagnostic); err != nil {
		s.record(ctx, "append", "rejected", "environment", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := ValidateDiagnosticIntake(diagnostic, request.Events, started); err != nil {
		s.record(ctx, "append", "rejected", "lifecycle", started)
		return AppendDiagnosticEventsResult{}, err
	}
	diagnostic = sanitizeDiagnosticConfig(diagnostic)
	result, err := s.repository.Append(ctx, diagnostic, participantID, validated)
	if result.DiagnosticReference == "" {
		result.DiagnosticReference = referenceFor(diagnostic)
	}
	s.record(ctx, "append", outcome(err), errorClass(err), started)
	return result, err
}

func (s Service) Resolve(ctx context.Context, operator OperatorPrincipal, reference string) (DiagnosticResolverResponseV1, error) {
	parsed, diagnostic, err := s.resolve(ctx, operator, reference, "read")
	if err != nil {
		return DiagnosticResolverResponseV1{}, err
	}
	snapshot, err := s.repository.ReadSnapshot(ctx, diagnostic, DiagnosticFilterV1{}, MaxSnapshotOperations)
	if err != nil {
		return DiagnosticResolverResponseV1{}, err
	}
	result := DiagnosticResolverResponseV1{Kind: "diagnostic", Reference: reference, Snapshot: &snapshot}
	if parsed.Focus == nil {
		return result, nil
	}
	switch parsed.Focus.Kind {
	case ReferenceFocusOperation:
		for index := range snapshot.Operations {
			if snapshot.Operations[index].ID == parsed.Focus.ID {
				result.Kind, result.Operation = "operation", &snapshot.Operations[index]
				return result, nil
			}
		}
	case ReferenceFocusIssue:
		for index := range snapshot.Issues {
			if snapshot.Issues[index].ID == parsed.Focus.ID {
				result.Kind, result.Issue = "issue", &snapshot.Issues[index]
				return result, nil
			}
		}
	case ReferenceFocusEvent:
		cursor := parsed.Cursor
		if cursor == nil {
			return DiagnosticResolverResponseV1{}, ErrInvalidReference
		}
		after := *cursor - 1
		before := *cursor + 1
		page, pageErr := s.repository.PageEvents(ctx, diagnostic, DiagnosticFilterV1{}, &after, &before, 1)
		if pageErr == nil && len(page.Events) == 1 && page.Events[0].Cursor == *cursor {
			result.Kind, result.Event = "event", &page.Events[0]
			return result, nil
		}
	}
	return DiagnosticResolverResponseV1{}, ErrNotFound
}

func (s Service) Snapshot(ctx context.Context, operator OperatorPrincipal, reference string, filter DiagnosticFilterV1) (DiagnosticSnapshotV1, error) {
	if err := ValidateFilter(filter); err != nil {
		return DiagnosticSnapshotV1{}, err
	}
	_, diagnostic, err := s.resolve(ctx, operator, reference, "read")
	if err != nil {
		return DiagnosticSnapshotV1{}, err
	}
	queryFilter, err := s.filterForStorage(filter)
	if err != nil {
		return DiagnosticSnapshotV1{}, err
	}
	return s.repository.ReadSnapshot(ctx, diagnostic, queryFilter, MaxSnapshotOperations)
}

func (s Service) Events(ctx context.Context, operator OperatorPrincipal, reference string, filter DiagnosticFilterV1, after, before *int64, limit int) (DiagnosticEventPageV1, error) {
	if err := ValidateFilter(filter); err != nil {
		return DiagnosticEventPageV1{}, err
	}
	_, diagnostic, err := s.resolve(ctx, operator, reference, "read")
	if err != nil {
		return DiagnosticEventPageV1{}, err
	}
	queryFilter, err := s.filterForStorage(filter)
	if err != nil {
		return DiagnosticEventPageV1{}, err
	}
	page, err := s.repository.PageEvents(ctx, diagnostic, queryFilter, after, before, boundedPageSize(limit))
	page.FilterFingerprint = FilterFingerprint(filter)
	return page, err
}

func (s Service) Operations(ctx context.Context, operator OperatorPrincipal, reference string, filter DiagnosticFilterV1, after *int64, limit int) (DiagnosticOperationPageV1, error) {
	if err := ValidateFilter(filter); err != nil {
		return DiagnosticOperationPageV1{}, err
	}
	_, diagnostic, err := s.resolve(ctx, operator, reference, "read")
	if err != nil {
		return DiagnosticOperationPageV1{}, err
	}
	queryFilter, err := s.filterForStorage(filter)
	if err != nil {
		return DiagnosticOperationPageV1{}, err
	}
	page, err := s.repository.PageOperations(ctx, diagnostic, queryFilter, after, boundedPageSize(limit))
	page.FilterFingerprint = FilterFingerprint(filter)
	return page, err
}

// PrepareFilter converts copyable operator input into its storage-safe form.
// Callers must retain FilterFingerprint(input) for the wire fingerprint.
func (s Service) PrepareFilter(filter DiagnosticFilterV1) (DiagnosticFilterV1, error) {
	if err := ValidateFilter(filter); err != nil {
		return DiagnosticFilterV1{}, err
	}
	return s.filterForStorage(filter)
}

func (s Service) Changes(ctx context.Context, operator OperatorPrincipal, reference string, after int64, limit int) (EpisodeDiagnostic, []ProjectionChange, error) {
	_, diagnostic, err := s.resolve(ctx, operator, reference, "stream")
	if err != nil {
		return EpisodeDiagnostic{}, nil, err
	}
	changes, err := s.repository.ListProjectionChanges(ctx, diagnostic, after, boundedPageSize(limit))
	return diagnostic, changes, err
}

func (s Service) Brief(ctx context.Context, operator OperatorPrincipal, reference, format string, aroundSeconds int64, branchID string) (AgentBriefResponseV1, error) {
	if aroundSeconds < 0 || aroundSeconds > 3600 || branchID != "" && !SafeOpaqueID(branchID) {
		return AgentBriefResponseV1{}, errors.New("invalid agent brief selection")
	}
	parsed, diagnostic, err := s.resolve(ctx, operator, reference, "read")
	if err != nil {
		return AgentBriefResponseV1{}, err
	}
	filter := DiagnosticFilterV1{}
	if aroundSeconds > 0 {
		if parsed.Cursor == nil {
			return AgentBriefResponseV1{}, errors.New("agent brief around window requires a cursor")
		}
		after := *parsed.Cursor - 1
		before := *parsed.Cursor + 1
		page, pageErr := s.repository.PageEvents(ctx, diagnostic, DiagnosticFilterV1{}, &after, &before, 1)
		if pageErr != nil {
			return AgentBriefResponseV1{}, pageErr
		}
		if len(page.Events) != 1 || page.Events[0].Cursor != *parsed.Cursor {
			return AgentBriefResponseV1{}, ErrNotFound
		}
		window := time.Duration(aroundSeconds) * time.Second
		filter.FromTime = page.Events[0].OccurredAt.Add(-window)
		filter.ToTime = page.Events[0].OccurredAt.Add(window)
	}
	snapshot, err := s.repository.ReadSnapshot(ctx, diagnostic, filter, MaxSnapshotOperations)
	if err != nil {
		return AgentBriefResponseV1{}, err
	}
	if branchID != "" {
		if !narrowBriefToBranch(&snapshot, branchID) {
			return AgentBriefResponseV1{}, ErrNotFound
		}
		snapshot.Omissions = append(snapshot.Omissions, "Agent Brief narrowed to epilogue branch "+branchID+".")
	}
	if aroundSeconds > 0 {
		snapshot.Omissions = append(snapshot.Omissions, fmt.Sprintf("Agent Brief narrowed to %d seconds around cursor %d.", aroundSeconds, *parsed.Cursor))
	}
	brief := BuildAgentBrief(snapshot, parsed, s.now())
	response := AgentBriefResponseV1{SchemaVersion: "AgentBriefResponse/v1", Format: format, Brief: brief}
	if format == "markdown" {
		response.Markdown = RenderAgentBriefMarkdown(brief)
	} else if format != "compact" {
		return AgentBriefResponseV1{}, errors.New("invalid Agent Brief format")
	}
	return response, nil
}

func narrowBriefToBranch(snapshot *DiagnosticSnapshotV1, branchID string) bool {
	if snapshot == nil {
		return false
	}
	branches := make([]DiagnosticBranchDetail, 0, 1)
	for _, branch := range snapshot.Branches {
		if branch.ID == branchID {
			branches = append(branches, branch)
		}
	}
	if len(branches) == 0 {
		return false
	}
	operations := make([]DiagnosticOperationDetail, 0)
	operationIDs := make(map[string]struct{})
	for _, operation := range snapshot.Operations {
		if operation.BranchID == branchID {
			operations = append(operations, operation)
			operationIDs[operation.ID] = struct{}{}
		}
	}
	issues := make([]DiagnosticIssueDetail, 0)
	for _, issue := range snapshot.Issues {
		if _, ok := operationIDs[issue.OperationID]; ok {
			issues = append(issues, issue)
		}
	}
	snapshot.Branches = branches
	snapshot.Operations = operations
	snapshot.Issues = issues
	snapshot.Summary.OperationCount = int64(len(operations))
	snapshot.Summary.IssueCount = int64(len(issues))
	snapshot.Summary.OpenIssueCount = 0
	for _, issue := range issues {
		if issue.State == IssueOpen {
			snapshot.Summary.OpenIssueCount++
		}
	}
	return true
}

func (s Service) CreateExport(ctx context.Context, operator OperatorPrincipal, reference string, cursorFrom int64, cursorTo *int64) (DiagnosticExportJob, error) {
	_, diagnostic, err := s.resolve(ctx, operator, reference, "export")
	if err != nil {
		return DiagnosticExportJob{}, err
	}
	return s.repository.CreateExport(ctx, diagnostic, operator, cursorFrom, cursorTo, s.now().Add(ExportLease))
}

func (s Service) Export(ctx context.Context, operator OperatorPrincipal, reference, jobID string) (DiagnosticExportJob, error) {
	_, diagnostic, err := s.resolve(ctx, operator, reference, "export")
	if err != nil {
		return DiagnosticExportJob{}, err
	}
	id, err := utilities.ParseID(jobID)
	if err != nil {
		return DiagnosticExportJob{}, ErrExportNotFound
	}
	return s.repository.GetExport(ctx, diagnostic, operator, id)
}

func (s Service) CancelExport(ctx context.Context, operator OperatorPrincipal, reference, jobID string) (DiagnosticExportJob, error) {
	_, diagnostic, err := s.resolve(ctx, operator, reference, "export")
	if err != nil {
		return DiagnosticExportJob{}, err
	}
	id, err := utilities.ParseID(jobID)
	if err != nil {
		return DiagnosticExportJob{}, ErrExportNotFound
	}
	return s.repository.CancelExport(ctx, diagnostic, operator, id, s.now())
}

func (s Service) Download(ctx context.Context, operator OperatorPrincipal, reference, jobID string) (ExportArtifact, error) {
	_, diagnostic, err := s.resolve(ctx, operator, reference, "export")
	if err != nil {
		return ExportArtifact{}, err
	}
	id, err := utilities.ParseID(jobID)
	if err != nil {
		return ExportArtifact{}, ErrExportNotFound
	}
	return s.repository.ExportArtifact(ctx, diagnostic, operator, id)
}

func (s Service) AlternateReference(ctx context.Context, operator OperatorPrincipal, idClass, value string) (DiagnosticReference, error) {
	if err := ValidateOperatorPrincipal(operator); err != nil {
		return DiagnosticReference{}, err
	}
	if !operator.Can("read") || operator.Environment != s.environment {
		return DiagnosticReference{}, ErrForbidden
	}
	lookup, version, err := s.alternateLookup(idClass, value)
	if err != nil {
		return DiagnosticReference{}, err
	}
	reference, err := s.repository.ResolveAlternate(ctx, idClass, lookup, version)
	if err != nil {
		return DiagnosticReference{}, err
	}
	diagnostic, err := s.repository.Resolve(ctx, reference)
	if err != nil {
		return DiagnosticReference{}, err
	}
	if err := ValidateOperatorTenantScope(operator, diagnostic); err != nil {
		return DiagnosticReference{}, err
	}
	if err := ValidateOperatorEnvironment(operator, diagnostic); err != nil {
		return DiagnosticReference{}, err
	}
	if err := s.writeReadAudit(ctx, sanitizeDiagnosticConfig(diagnostic), operator, "read"); err != nil {
		return DiagnosticReference{}, err
	}
	return reference, nil
}

func (s Service) alternateLookup(idClass, value string) (string, string, error) {
	switch idClass {
	case "chalk.request", "chalk.command", "chalk.journey":
		if !ValidSafeIdentifierValue(idClass, value) {
			return "", "", ErrInvalidReference
		}
		return value, "", nil
	case "w3c.trace":
		traceID, spanID, ok := strings.Cut(value, "_")
		if !ok || strings.Contains(spanID, "_") || !ValidSafeIdentifierValue("w3c.trace", traceID) || !ValidSafeIdentifierValue("w3c.span", spanID) {
			return "", "", ErrInvalidReference
		}
		return TraceSpanReferenceValue(traceID, spanID), "", nil
	case "provider":
		if !ValidSafeIdentifierValue(idClass, value) {
			return "", "", ErrInvalidReference
		}
		if len(s.hmacKey) == 0 {
			return "", "", ErrNotFound
		}
		return s.safeIdentifierToken(idClass, value), "v1", nil
	default:
		return "", "", ErrInvalidReference
	}
}

func (s Service) resolve(ctx context.Context, operator OperatorPrincipal, reference, capability string) (DiagnosticReference, EpisodeDiagnostic, error) {
	if err := ValidateOperatorPrincipal(operator); err != nil {
		return DiagnosticReference{}, EpisodeDiagnostic{}, err
	}
	if !operator.Can(capability) || operator.Environment != s.environment {
		return DiagnosticReference{}, EpisodeDiagnostic{}, ErrForbidden
	}
	parsed, err := ParseReference(reference)
	if err != nil || parsed.Environment != s.environment {
		return DiagnosticReference{}, EpisodeDiagnostic{}, ErrInvalidReference
	}
	if operator.Environment != parsed.Environment {
		return DiagnosticReference{}, EpisodeDiagnostic{}, ErrForbidden
	}
	diagnostic, err := s.repository.Resolve(ctx, parsed)
	if err != nil {
		return DiagnosticReference{}, EpisodeDiagnostic{}, err
	}
	if err := ValidateOperatorTenantScope(operator, diagnostic); err != nil {
		return DiagnosticReference{}, EpisodeDiagnostic{}, err
	}
	if err := ValidateOperatorEnvironment(operator, diagnostic); err != nil {
		return DiagnosticReference{}, EpisodeDiagnostic{}, err
	}
	diagnostic = sanitizeDiagnosticConfig(diagnostic)
	if err := s.writeReadAudit(ctx, diagnostic, operator, capability); err != nil {
		return DiagnosticReference{}, EpisodeDiagnostic{}, err
	}
	return parsed, diagnostic, nil
}

func (s Service) writeReadAudit(ctx context.Context, diagnostic EpisodeDiagnostic, operator OperatorPrincipal, capability string) error {
	if s.audits == nil {
		if s.environment == EnvironmentLocalhost {
			return nil
		}
		return ErrAuditUnavailable
	}
	if err := s.audits.WriteDiagnosticAudit(ctx, diagnostic, operator, capability, "success", ""); err != nil && s.environment != EnvironmentLocalhost {
		return fmt.Errorf("%w: %v", ErrAuditUnavailable, err)
	}
	return nil
}

func authorizeProducer(principal ProducerPrincipal, request AppendDiagnosticEventsRequest) error {
	if principal.ID == "" || principal.Environment == "" || len(principal.AllowedSources) == 0 {
		return ErrUnauthenticated
	}
	if request.Producer.ID != principal.ID || request.Producer.InstanceID != principal.InstanceID || request.Producer.Generation != principal.Generation {
		return ErrForbidden
	}
	return nil
}

func boundScope(principal ProducerPrincipal, supplied *AppendScope) (AppendScope, *utilities.ID, error) {
	bound := AppendScope{TenantID: principal.TenantID.String(), SpaceID: principal.SpaceID.String(), EpisodeID: principal.EpisodeID.String(), ParticipantID: principal.ParticipantID.String()}
	if principal.Kind == ProducerService {
		if supplied == nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
		bound = *supplied
	} else if supplied != nil {
		if supplied.TenantID != bound.TenantID || supplied.SpaceID != bound.SpaceID || supplied.EpisodeID != bound.EpisodeID || supplied.ParticipantID != "" && supplied.ParticipantID != bound.ParticipantID {
			return AppendScope{}, nil, ErrForbidden
		}
	}
	var participant *utilities.ID
	if bound.ParticipantID != "" {
		id, err := utilities.ParseID(bound.ParticipantID)
		if err != nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
		participant = &id
	}
	for _, value := range []string{bound.TenantID, bound.SpaceID, bound.EpisodeID} {
		if _, err := utilities.ParseID(value); err != nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
	}
	return bound, participant, nil
}

func boundedPageSize(limit int) int {
	if limit <= 0 {
		return DefaultPageSize
	}
	if limit > MaxPageSize {
		return MaxPageSize
	}
	return limit
}

func outcome(err error) string {
	if err != nil {
		return "failure"
	}
	return "success"
}

func errorClass(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, ErrForbidden), errors.Is(err, ErrUnauthenticated):
		return "authorization"
	case errors.Is(err, ErrDiagnosticEnvironmentMismatch):
		return "environment"
	case errors.Is(err, ErrDiagnosticIntakeClosed):
		return "lifecycle_closed"
	case errors.Is(err, ErrDiagnosticExpired):
		return "expired"
	case errors.Is(err, ErrDiagnosticLifecycleInvalid):
		return "lifecycle"
	case errors.Is(err, ErrCapacity):
		return "capacity"
	case errors.Is(err, ErrConflict):
		return "conflict"
	default:
		var validationErr *ValidationError
		if errors.As(err, &validationErr) {
			return "validation"
		}
		return "internal"
	}
}

func (s Service) record(ctx context.Context, operation, result, reason string, started time.Time) {
	if s.telemetry != nil {
		s.telemetry.RecordDiagnostic(ctx, operation, result, reason, s.now().Sub(started))
	}
}

func (s Service) eventForStorage(event DiagnosticEventDraft) (DiagnosticEventDraft, error) {
	if event.Correlation == nil || event.Correlation.ProviderID == "" {
		return event, nil
	}
	if len(s.hmacKey) == 0 {
		return DiagnosticEventDraft{}, errors.New("provider identifier HMAC key is unavailable")
	}
	correlation := *event.Correlation
	correlation.ProviderID = s.safeIdentifierToken("provider", correlation.ProviderID)
	event.Correlation = &correlation
	return event, nil
}

func (s Service) filterForStorage(filter DiagnosticFilterV1) (DiagnosticFilterV1, error) {
	if filter.ProviderID == "" {
		return filter, nil
	}
	if len(s.hmacKey) == 0 {
		return DiagnosticFilterV1{}, errors.New("provider identifier HMAC key is unavailable")
	}
	filter.ProviderID = s.safeIdentifierToken("provider", filter.ProviderID)
	return filter, nil
}

func (s Service) safeIdentifierToken(idClass, value string) string {
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte(string(s.environment) + "\x00" + idClass + "\x00" + value))
	return "hmac:v1:" + hex.EncodeToString(mac.Sum(nil))
}

func TraceSpanReferenceValue(traceID, spanID string) string {
	digest := sha256.Sum256([]byte(traceID + "\x00" + spanID))
	return hex.EncodeToString(digest[:16])
}

func referenceFor(diagnostic EpisodeDiagnostic) string {
	reference, _ := FormatReference(DiagnosticReference{Version: 1, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID})
	return reference
}
