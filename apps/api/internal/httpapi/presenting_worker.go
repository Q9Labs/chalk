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

func mountPresentingWorkerRoutes(r chi.Router, service interface {
	ClaimRender(context.Context, presenting.RenderCapability) (presenting.ControlAssignment, bool, error)
	HeartbeatRender(context.Context, presenting.RenderLease) error
	CompleteInventory(context.Context, presenting.InventoryReport) error
	MarkPageReady(context.Context, presenting.RenderLease, int) error
	CompleteRender(context.Context, presenting.RenderLease) error
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}, authorizer PresentingCapabilityAuthorizer) {
	if service == nil || authorizer == nil {
		return
	}
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

func presentingClaimHandler(service interface {
	ClaimRender(context.Context, presenting.RenderCapability) (presenting.ControlAssignment, bool, error)
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		capability, ok := authorizePresentingCapability(w, r, auth)
		if !ok {
			return
		}
		var body presentingClaimBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid request body")
			return
		}
		jobID, err := utilities.ParseID(body.JobID)
		if err != nil || jobID != capability.JobID {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid job id")
			return
		}
		assignment, found, err := service.ClaimRender(r.Context(), capability)
		if err != nil {
			writePresentingWorkerError(w, err)
			return
		}
		if !found {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, assignment)
	}
}

func presentingHeartbeatHandler(service interface {
	HeartbeatRender(context.Context, presenting.RenderLease) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, "", func(ctx context.Context, lease presenting.RenderLease) error {
		return service.HeartbeatRender(ctx, lease)
	})
}

func presentingCompleteHandler(service interface {
	CompleteRender(context.Context, presenting.RenderLease) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, "", func(ctx context.Context, lease presenting.RenderLease) error {
		return service.CompleteRender(ctx, lease)
	})
}

func presentingZoomCompleteHandler(service interface {
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, "zoom", func(ctx context.Context, lease presenting.RenderLease) error {
		return service.CompleteZoomRender(ctx, lease)
	})
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

func presentingInventoryHandler(service interface {
	CompleteInventory(context.Context, presenting.InventoryReport) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		capability, ok := authorizePresentingCapability(w, r, auth)
		if !ok {
			return
		}
		if capability.Kind != "inventory" {
			writeCapabilityLeaseMismatch(w)
			return
		}
		var body presentingInventoryBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid inventory report")
			return
		}
		lease, err := presentingLease(body.presentingWorkerLeaseBody)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease")
			return
		}
		if !capabilityMatchesLease(capability, lease) {
			writeCapabilityLeaseMismatch(w)
			return
		}
		pages := make([]presenting.PageSpec, 0, len(body.Pages))
		for _, page := range body.Pages {
			pages = append(pages, presenting.PageSpec{Page: page.Page, Width: page.Width, Height: page.Height})
		}
		if err := service.CompleteInventory(r.Context(), presenting.InventoryReport{Lease: lease, PageCount: body.PageCount, Pages: pages}); err != nil {
			writePresentingWorkerError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func presentingPageReadyHandler(service interface {
	MarkPageReady(context.Context, presenting.RenderLease, int) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		capability, ok := authorizePresentingCapability(w, r, auth)
		if !ok {
			return
		}
		if capability.Kind != "inventory" && capability.Kind != "pages" {
			writeCapabilityLeaseMismatch(w)
			return
		}
		var body presentingPageReadyBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid page report")
			return
		}
		lease, err := presentingLease(body.presentingWorkerLeaseBody)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease")
			return
		}
		if !capabilityMatchesLease(capability, lease) || body.Page < capability.PageStart || body.Page > capability.PageEnd {
			writeCapabilityLeaseMismatch(w)
			return
		}
		if err := service.MarkPageReady(r.Context(), lease, body.Page); err != nil {
			writePresentingWorkerError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func presentingFailHandler(service interface {
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
}, auth PresentingCapabilityAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		capability, ok := authorizePresentingCapability(w, r, auth)
		if !ok {
			return
		}
		var body presentingFailureBody
		if err := decodeJSON(r, &body); err != nil || body.Code == "" {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid failure report")
			return
		}
		lease, err := presentingLease(body.presentingWorkerLeaseBody)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease")
			return
		}
		if !capabilityMatchesLease(capability, lease) {
			writeCapabilityLeaseMismatch(w)
			return
		}
		if err := service.FailRender(r.Context(), lease, presenting.RenderFailure{Code: body.Code, Message: body.Message}); err != nil {
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
