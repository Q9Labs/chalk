package episodediagnostics

import (
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrDiagnosticEnvironmentMismatch = errors.New("diagnostic principal environment does not match diagnostic environment")
	ErrDiagnosticIntakeClosed        = errors.New("diagnostic intake is closed")
	ErrDiagnosticExpired             = errors.New("diagnostic has expired")
	ErrDiagnosticLifecycleInvalid    = errors.New("diagnostic lifecycle is invalid")
)

var operatorSubjectHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Short aliases keep the errors usable by adapters without coupling callers
// to the internal naming used by Service.
var (
	ErrEnvironmentMismatch = ErrDiagnosticEnvironmentMismatch
	ErrIntakeClosed        = ErrDiagnosticIntakeClosed
)

const (
	// EndedDiagnosticIntakeGrace is the maximum period in which a late
	// producer callback may be attached after the authoritative Episode end.
	// It is deliberately the same hard ceiling used for epilogue leases.
	EndedDiagnosticIntakeGrace = 24 * time.Hour
	DiagnosticAbsoluteExpiry   = 24 * time.Hour
)

func validateEnvironment(principal, diagnostic Environment) error {
	if principal == "" || diagnostic == "" || principal != diagnostic {
		return ErrDiagnosticEnvironmentMismatch
	}
	return nil
}

func ValidateProducerEnvironment(principal ProducerPrincipal, diagnostic EpisodeDiagnostic) error {
	return validateEnvironment(principal.Environment, diagnostic.Environment)
}

func ValidateOperatorEnvironment(principal OperatorPrincipal, diagnostic EpisodeDiagnostic) error {
	return validateEnvironment(principal.Environment, diagnostic.Environment)
}

func ValidateOperatorPrincipal(principal OperatorPrincipal) error {
	if principal.SubjectHash == "" {
		return ErrUnauthenticated
	}
	if !operatorSubjectHashPattern.MatchString(principal.SubjectHash) {
		return ErrForbidden
	}
	if principal.Environment == "" {
		return ErrForbidden
	}
	if len(principal.AuthorizedTenantIDs) > MaxOperatorTenantIDs || principal.TenantScopeRequired && len(principal.AuthorizedTenantIDs) == 0 {
		return ErrForbidden
	}
	seenTenantIDs := make(map[string]struct{}, len(principal.AuthorizedTenantIDs))
	for _, tenantID := range principal.AuthorizedTenantIDs {
		parsed, err := utilities.ParseID(tenantID)
		if err != nil || parsed.String() != tenantID {
			return ErrForbidden
		}
		if _, exists := seenTenantIDs[tenantID]; exists {
			return ErrForbidden
		}
		seenTenantIDs[tenantID] = struct{}{}
	}
	return nil
}

// ValidateOperatorTenantScope is deliberately called only after the opaque
// diagnostic reference has resolved to an authoritative row. A denied tenant
// always returns ErrForbidden so callers cannot distinguish an unauthorized
// tenant from any other authorization failure by probing references.
func ValidateOperatorTenantScope(principal OperatorPrincipal, diagnostic EpisodeDiagnostic) error {
	if !principal.TenantScopeRequired && len(principal.AuthorizedTenantIDs) == 0 {
		return nil
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil || tenantID.String() != diagnostic.TenantID {
		return ErrForbidden
	}
	for _, authorizedTenantID := range principal.AuthorizedTenantIDs {
		if authorizedTenantID == diagnostic.TenantID {
			return nil
		}
	}
	return ErrForbidden
}

// DiagnosticIntakeDeadline returns the authoritative hard cutoff. The
// diagnostic's own expiry, when present, can only shorten the window.
func DiagnosticIntakeDeadline(diagnostic EpisodeDiagnostic) (time.Time, bool) {
	if diagnostic.EpisodeEndedAt == nil || diagnostic.EpisodeEndedAt.IsZero() {
		return time.Time{}, false
	}
	deadline := diagnostic.EpisodeEndedAt.UTC().Add(EndedDiagnosticIntakeGrace)
	if diagnostic.ExpiresAt != nil && !diagnostic.ExpiresAt.IsZero() && diagnostic.ExpiresAt.Before(deadline) {
		deadline = diagnostic.ExpiresAt.UTC()
	}
	return deadline, true
}

func DiagnosticAbsoluteDeadline(diagnostic EpisodeDiagnostic) (time.Time, bool) {
	if diagnostic.EpisodeEndedAt == nil || diagnostic.EpisodeEndedAt.IsZero() {
		return time.Time{}, false
	}
	return diagnostic.EpisodeEndedAt.UTC().Add(DiagnosticAbsoluteExpiry), true
}

// ValidateDiagnosticIntake enforces lifecycle admission against authoritative
// timestamps. Producer OccurredAt is bounded by the authoritative run start,
// server observation time, and the ended hard cutoff; it cannot extend grace.
func ValidateDiagnosticIntake(diagnostic EpisodeDiagnostic, events []DiagnosticEventDraft, now time.Time) error {
	now = now.UTC()
	if now.IsZero() {
		return ErrDiagnosticLifecycleInvalid
	}
	if diagnostic.State == DiagnosticExpired {
		return ErrDiagnosticExpired
	}
	if diagnostic.State == DiagnosticComplete {
		return ErrDiagnosticIntakeClosed
	}
	if diagnostic.State != DiagnosticLive && diagnostic.State != DiagnosticEnded {
		return ErrDiagnosticLifecycleInvalid
	}
	startedAt := diagnostic.EpisodeStartedAt.UTC()
	var endedAt time.Time
	if diagnostic.State == DiagnosticEnded {
		if diagnostic.EpisodeEndedAt == nil || diagnostic.EpisodeEndedAt.IsZero() {
			return ErrDiagnosticLifecycleInvalid
		}
		endedAt = diagnostic.EpisodeEndedAt.UTC()
		if startedAt.IsZero() {
			return ErrDiagnosticLifecycleInvalid
		}
		deadline, ok := DiagnosticIntakeDeadline(diagnostic)
		if !ok || !now.Before(deadline) {
			return ErrDiagnosticIntakeClosed
		}
	}
	for _, event := range events {
		occurredAt := event.OccurredAt.UTC()
		if (!startedAt.IsZero() && occurredAt.Before(startedAt)) || occurredAt.After(now) {
			return fmt.Errorf("%w: event %q occurredAt is outside authoritative bounds", ErrDiagnosticIntakeClosed, event.EventID)
		}
		if !endedAt.IsZero() && occurredAt.After(endedAt.Add(EndedDiagnosticIntakeGrace)) {
			return fmt.Errorf("%w: event %q occurred after the ended intake grace", ErrDiagnosticIntakeClosed, event.EventID)
		}
	}
	return nil
}

func ValidateDiagnosticAppend(diagnostic EpisodeDiagnostic, events []DiagnosticEventDraft, now time.Time) error {
	return ValidateDiagnosticIntake(diagnostic, events, now)
}

func (diagnostic EpisodeDiagnostic) IntakeAllowedAt(now time.Time) bool {
	return ValidateDiagnosticIntake(diagnostic, nil, now) == nil
}

func terminalBranchState(state BranchState) bool {
	switch state {
	case BranchSucceeded, BranchFailed, BranchCancelled, BranchTimedOut:
		return true
	default:
		return false
	}
}

func maxTime(current time.Time, candidate *time.Time) time.Time {
	if candidate == nil || candidate.IsZero() {
		return current
	}
	if current.IsZero() || candidate.After(current) {
		return candidate.UTC()
	}
	return current
}

// ReconcileDiagnosticLifecycle performs the normal bounded ended -> complete
// transition. It never reopens a terminal diagnostic and times out pending
// branches at the authoritative Episode-end + 24h ceiling.
func ReconcileDiagnosticLifecycle(diagnostic EpisodeDiagnostic, branches []DiagnosticBranchDetail, now time.Time) (EpisodeDiagnostic, []DiagnosticBranchDetail, error) {
	return reconcileDiagnosticLifecycle(diagnostic, branches, now, true)
}

// ReconcileDiagnosticLifecycleObserver advances an authoritative end and
// completes only when every branch is already terminal. Deadline workers own
// timeout transitions through ledger events; reconciliation must not mutate a
// pending branch behind the projector's back.
func ReconcileDiagnosticLifecycleObserver(diagnostic EpisodeDiagnostic, branches []DiagnosticBranchDetail, now time.Time) (EpisodeDiagnostic, []DiagnosticBranchDetail, error) {
	return reconcileDiagnosticLifecycle(diagnostic, branches, now, false)
}

func reconcileDiagnosticLifecycle(diagnostic EpisodeDiagnostic, branches []DiagnosticBranchDetail, now time.Time, timeoutPending bool) (EpisodeDiagnostic, []DiagnosticBranchDetail, error) {
	now = now.UTC()
	if now.IsZero() {
		return EpisodeDiagnostic{}, nil, ErrDiagnosticLifecycleInvalid
	}
	if diagnostic.State == DiagnosticExpired {
		return diagnostic, append([]DiagnosticBranchDetail(nil), branches...), nil
	}
	if diagnostic.State == DiagnosticComplete {
		return diagnostic, append([]DiagnosticBranchDetail(nil), branches...), nil
	}
	if diagnostic.EpisodeEndedAt == nil || diagnostic.EpisodeEndedAt.IsZero() {
		if diagnostic.State == DiagnosticEnded {
			return EpisodeDiagnostic{}, nil, ErrDiagnosticLifecycleInvalid
		}
		return diagnostic, append([]DiagnosticBranchDetail(nil), branches...), nil
	}
	endedAt := diagnostic.EpisodeEndedAt.UTC()
	if diagnostic.State == DiagnosticLive {
		diagnostic.State = DiagnosticEnded
	}
	if diagnostic.State != DiagnosticEnded {
		return EpisodeDiagnostic{}, nil, ErrDiagnosticLifecycleInvalid
	}

	updatedBranches := append([]DiagnosticBranchDetail(nil), branches...)
	allTerminal := true
	completionAt := endedAt
	for index := range updatedBranches {
		branch := &updatedBranches[index]
		leaseDeadline := endedAt.Add(DiagnosticAbsoluteExpiry)
		if branch.LeaseEndsAt.IsZero() || branch.LeaseEndsAt.After(leaseDeadline) {
			branch.LeaseEndsAt = leaseDeadline
		}
		if !terminalBranchState(branch.State) {
			if !timeoutPending {
				allTerminal = false
				continue
			}
			if !now.Before(leaseDeadline) || !now.Before(branch.LeaseEndsAt) {
				branch.State = BranchTimedOut
				branch.TerminalAt = timePtr(branch.LeaseEndsAt)
				branch.UnknownReason = UnknownExpired
				if branch.TerminalAt.After(completionAt) {
					completionAt = *branch.TerminalAt
				}
			} else {
				allTerminal = false
			}
		}
		if terminalBranchState(branch.State) {
			completionAt = maxTime(completionAt, branch.TerminalAt)
		} else {
			allTerminal = false
		}
	}
	if !allTerminal {
		return diagnostic, updatedBranches, nil
	}
	diagnostic.State = DiagnosticComplete
	completedAt := completionAt.UTC()
	diagnostic.EpilogueCompletedAt = timePtr(completedAt)
	expiresAt := completedAt.Add(RetentionPeriod)
	diagnostic.ExpiresAt = timePtr(expiresAt)
	return diagnostic, updatedBranches, nil
}

// AdvanceDiagnosticLifecycle mutates a caller-owned diagnostic and branch
// slice, making it convenient for deadline workers while retaining the pure
// ReconcileDiagnosticLifecycle function for replay/tests.
func AdvanceDiagnosticLifecycle(diagnostic *EpisodeDiagnostic, branches []DiagnosticBranchDetail, now time.Time) error {
	if diagnostic == nil {
		return ErrDiagnosticLifecycleInvalid
	}
	next, updated, err := ReconcileDiagnosticLifecycle(*diagnostic, branches, now)
	if err != nil {
		return err
	}
	*diagnostic = next
	copy(branches, updated)
	return nil
}
