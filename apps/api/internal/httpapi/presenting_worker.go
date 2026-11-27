package httpapi

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const presentingWorkloadRole = "document-renderer"

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
