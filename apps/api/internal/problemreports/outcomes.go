package problemreports

import "github.com/q9labs/chalk/apps/api/internal/utilities"

// Outcome is the closed set of terminal submission results. No input becomes a label.
type Outcome uint8

const (
	OutcomeInternalFailed Outcome = iota
	OutcomeAccepted
	OutcomeInvalidTenant
	OutcomeInvalidJSON
	OutcomeDescriptionBlank
	OutcomeDescriptionTooLong
	OutcomeDiagnosticsTooLong
	OutcomeCredentialsDetected
	OutcomeUnauthenticated
	OutcomeTenantScopeMismatch
	OutcomeParticipantBindingMismatch
	OutcomeParticipantQuota
	OutcomeEpisodeQuota
	OutcomeIPQuota
	OutcomeAccountQuota
	OutcomeDisabled
	OutcomeLimiterUnavailable
	OutcomeVerifierUnavailable
	OutcomeAttributionFailed
	OutcomeCredentialSourceFailed
	OutcomeDiscordFailed
	OutcomeIDGenerationFailed
	OutcomePayloadTooLarge
	OutcomeJourneyTimeout
	OutcomeJourneyCanceled
	OutcomeJourneyPermission
	OutcomeJourneyConstraint
	OutcomeJourneyUnavailable
	OutcomeJourneyInternal
	outcomeCount
)

var outcomeCauses = [...]string{
	OutcomeAccepted:                   "accepted",
	OutcomeInvalidTenant:              "invalid_tenant",
	OutcomeInvalidJSON:                "invalid_json",
	OutcomeDescriptionBlank:           "description_blank",
	OutcomeDescriptionTooLong:         "description_too_long",
	OutcomeDiagnosticsTooLong:         "diagnostics_too_long",
	OutcomeCredentialsDetected:        "credentials_detected",
	OutcomeUnauthenticated:            "unauthenticated",
	OutcomeTenantScopeMismatch:        "tenant_scope_mismatch",
	OutcomeParticipantBindingMismatch: "participant_binding_mismatch",
	OutcomeParticipantQuota:           "participant_quota",
	OutcomeEpisodeQuota:               "episode_quota",
	OutcomeIPQuota:                    "ip_quota",
	OutcomeAccountQuota:               "account_quota",
	OutcomeDisabled:                   "disabled",
	OutcomeLimiterUnavailable:         "limiter_unavailable",
	OutcomeVerifierUnavailable:        "verifier_unavailable",
	OutcomeAttributionFailed:          "attribution_failed",
	OutcomeCredentialSourceFailed:     "credentials_unavailable",
	OutcomeDiscordFailed:              "discord_failed",
	OutcomeIDGenerationFailed:         "id_generation_failed",
	OutcomePayloadTooLarge:            "payload_too_large",
	OutcomeInternalFailed:             "internal_failed",
	OutcomeJourneyTimeout:             "journey_timeout",
	OutcomeJourneyCanceled:            "journey_canceled",
	OutcomeJourneyPermission:          "journey_permission",
	OutcomeJourneyConstraint:          "journey_constraint",
	OutcomeJourneyUnavailable:         "journey_unavailable",
	OutcomeJourneyInternal:            "journey_internal",
}

func (o Outcome) Cause() string { return outcomeCauses[o] }

func Outcomes() []Outcome {
	result := make([]Outcome, outcomeCount)
	for i := range result {
		result[i] = Outcome(i)
	}
	return result
}

type Result struct {
	Outcome  Outcome
	ReportID utilities.ID
}
