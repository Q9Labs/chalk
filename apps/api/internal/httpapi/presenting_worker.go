package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const presentingWorkloadRole = "document-renderer"

type presentingWorkerLeaseBody struct {
	JobID      string `json:"job_id"`
	TenantID   string `json:"tenant_id"`
	SpaceID    string `json:"space_id"`
	DocumentID string `json:"document_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
	Page       int    `json:"page"`
}

func mountPresentingWorkerRoutes(r chi.Router, service interface {
	ClaimRender(context.Context, presenting.RenderCapability) (presenting.ControlAssignment, bool, error)
	HeartbeatRender(context.Context, presenting.RenderLease) error
	CompleteInventory(context.Context, presenting.InventoryReport) error
	MarkPageReady(context.Context, presenting.RenderLease, int) error
	CompleteRender(context.Context, presenting.RenderLease) error
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}, authorizer PresentingCapabilityAuthorizer) {
	r.Route("/internal/v1/presenting/render", func(r chi.Router) {
		r.Post("/claim", presentingClaimHandler(service, authorizer))
		r.Post("/heartbeat", presentingHeartbeatHandler(service, authorizer))
		r.Post("/inventory/complete", presentingInventoryHandler(service, authorizer))
		r.Post("/page-ready", presentingPageReadyHandler(service, authorizer))
		r.Post("/complete", presentingCompleteHandler(service, authorizer))
		r.Post("/fail", presentingFailHandler(service, authorizer))
		r.Post("/zoom/complete", presentingZoomCompleteHandler(service, authorizer))
	})
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

func presentingLeaseHandler(service any, auth PresentingCapabilityAuthorizer, kind string, complete func(context.Context, presenting.RenderLease) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		capability, ok := authorizePresentingCapability(w, r, auth)
		if !ok {
			return
		}
		if kind != "" && capability.Kind != kind {
			writeCapabilityLeaseMismatch(w)
			return
		}
		lease, err := decodePresentingLease(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease")
			return
		}
		if !capabilityMatchesLease(capability, lease) || (kind == "zoom" && lease.Page != capability.PageStart) {
			writeCapabilityLeaseMismatch(w)
			return
		}
		if err := complete(r.Context(), lease); err != nil {
			writePresentingWorkerError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
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
