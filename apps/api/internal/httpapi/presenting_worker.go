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
	DocumentID string `json:"document_id"`
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"lease_token"`
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
	ClaimRender(context.Context, utilities.ID) (presenting.ControlAssignment, bool, error)
	HeartbeatRender(context.Context, presenting.RenderLease) error
	CompleteInventory(context.Context, presenting.InventoryReport) error
	MarkPageReady(context.Context, presenting.RenderLease, int) error
	CompleteRender(context.Context, presenting.RenderLease) error
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}, authorizer WorkloadAuthorizer) {
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

func presentingClaimHandler(service interface {
	ClaimRender(context.Context, utilities.ID) (presenting.ControlAssignment, bool, error)
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, presentingWorkloadRole); err != nil {
			writeWorkloadUnauthorized(w, r, err)
			return
		}
		var body presentingClaimBody
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid request body")
			return
		}
		jobID := utilities.ID{}
		if body.JobID != "" {
			parsed, err := utilities.ParseID(body.JobID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "request.invalid", "Invalid job id")
				return
			}
			jobID = parsed
		}
		assignment, found, err := service.ClaimRender(r.Context(), jobID)
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
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, func(ctx context.Context, lease presenting.RenderLease) error {
		return service.HeartbeatRender(ctx, lease)
	})
}

func presentingCompleteHandler(service interface {
	CompleteRender(context.Context, presenting.RenderLease) error
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, func(ctx context.Context, lease presenting.RenderLease) error {
		return service.CompleteRender(ctx, lease)
	})
}

func presentingZoomCompleteHandler(service interface {
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return presentingLeaseHandler(service, auth, func(ctx context.Context, lease presenting.RenderLease) error {
		return service.CompleteZoomRender(ctx, lease)
	})
}

func presentingLeaseHandler(service any, auth WorkloadAuthorizer, complete func(context.Context, presenting.RenderLease) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, presentingWorkloadRole); err != nil {
			writeWorkloadUnauthorized(w, r, err)
			return
		}
		lease, err := decodePresentingLease(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid lease")
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
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, presentingWorkloadRole); err != nil {
			writeWorkloadUnauthorized(w, r, err)
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
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, presentingWorkloadRole); err != nil {
			writeWorkloadUnauthorized(w, r, err)
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
		if err := service.MarkPageReady(r.Context(), lease, body.Page); err != nil {
			writePresentingWorkerError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func presentingFailHandler(service interface {
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
}, auth WorkloadAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.AuthorizeWorkload(r.Context(), r, presentingWorkloadRole); err != nil {
			writeWorkloadUnauthorized(w, r, err)
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
	token, err := utilities.ParseID(body.LeaseToken)
	if err != nil || body.Attempt < 1 {
		return presenting.RenderLease{}, errors.New("invalid lease")
	}
	return presenting.RenderLease{JobID: jobID, DocumentID: documentID, Attempt: body.Attempt, LeaseToken: token, LeaseOwner: presentingWorkloadRole}, nil
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
