package httpapi

import (
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type presentingWorkerLeaseBody struct {
	JobID      string `json:"job_id"`
	TenantID   string `json:"tenant_id"`
	SpaceID    string `json:"space_id"`
	DocumentID string `json:"document_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
	Page       int    `json:"page"`
}

type presentingClaimBody struct {
	JobID string `json:"job_id"`
}

type presentingInventoryBody struct {
	presentingWorkerLeaseBody
	PageCount int `json:"page_count"`
	Pages     []struct {
		Page   int `json:"page"`
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"pages"`
}

type presentingPageReadyBody struct {
	presentingWorkerLeaseBody
	Page int `json:"page"`
}

type presentingFailureBody struct {
	presentingWorkerLeaseBody
	Code    string `json:"code"`
	Message string `json:"message"`
}

func authorizePresentingCapability(w http.ResponseWriter, r *http.Request, auth PresentingCapabilityAuthorizer) (presenting.RenderCapability, bool) {
	capability, err := auth.AuthorizePresentingRenderCapability(r)
	if err != nil {
		writePresentingCapabilityUnauthorized(w, err)
		return presenting.RenderCapability{}, false
	}
	return capability, true
}

func capabilityMatchesLease(capability presenting.RenderCapability, lease presenting.RenderLease) bool {
	return capability.MatchesLease(lease)
}

func writeCapabilityLeaseMismatch(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "presenting.capability_mismatch", "Render capability does not match this job lease")
}

func decodePresentingLease(r *http.Request) (presenting.RenderLease, error) {
	var body presentingWorkerLeaseBody
	if err := decodeJSON(r, &body); err != nil {
		return presenting.RenderLease{}, err
	}
	return presentingLease(body)
}

func presentingLease(body presentingWorkerLeaseBody) (presenting.RenderLease, error) {
	jobID, err := utilities.ParseID(body.JobID)
	if err != nil {
		return presenting.RenderLease{}, err
	}
	documentID, err := utilities.ParseID(body.DocumentID)
	if err != nil {
		return presenting.RenderLease{}, err
	}
	tenantID, err := utilities.ParseID(body.TenantID)
	if err != nil {
		return presenting.RenderLease{}, err
	}
	spaceID, err := utilities.ParseID(body.SpaceID)
	if err != nil {
		return presenting.RenderLease{}, err
	}
	token, err := utilities.ParseID(body.LeaseToken)
	if err != nil || body.Attempt < 1 {
		return presenting.RenderLease{}, errors.New("invalid lease")
	}
	return presenting.RenderLease{TenantID: tenantID, SpaceID: spaceID, JobID: jobID, DocumentID: documentID, Attempt: body.Attempt, LeaseToken: token, LeaseOwner: presentingWorkloadRole, Page: body.Page}, nil
}

func writePresentingWorkerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, presenting.ErrNoRenderJob):
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, presenting.ErrLeaseLost):
		writeError(w, http.StatusConflict, "presenting.lease_lost", "Render lease is no longer valid")
	case errors.Is(err, presenting.ErrInvalidInput):
		writeError(w, http.StatusBadRequest, "presenting.invalid_report", "Invalid renderer report")
	default:
		writeError(w, http.StatusInternalServerError, "presenting.render_control_failed", "Render control operation failed")
	}
}
