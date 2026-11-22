package httpapi

import (
	"context"
	"net/http"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/helperaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type helperPairBody struct {
	Version         uint8  `json:"version"`
	Challenge       string `json:"challenge"`
	HelperPublicKey string `json:"helperPublicKey"`
	LayerID         string `json:"layerId"`
	PublicationID   string `json:"publicationId"`
	Remembered      bool   `json:"remembered,omitempty"`
}

type helperPairRequest struct {
	body   helperPairBody
	origin string
	layer  utilities.ID
}

func helperPairTicketEndpoint(service *helperaccess.Service, origins []string) Endpoint[helperPairRequest, helperaccess.LocalTickets] {
	decode := func(r *http.Request) (helperPairRequest, error) {
		values := r.Header.Values("Origin")
		if len(values) != 1 || !slices.Contains(origins, values[0]) || r.Header.Get("Cookie") != "" {
			return helperPairRequest{}, apiErrorForbidden
		}
		body, err := decodeJSONBodyWithLimit[helperPairBody](r, 2048)
		if err != nil {
			return helperPairRequest{}, err
		}
		layer, err := utilities.ParseID(body.LayerID)
		if err != nil || body.Version != 1 {
			return helperPairRequest{}, apiErrorInvalidRequest
		}
		return helperPairRequest{body: body, origin: values[0], layer: layer}, nil
	}
	return Post("/v1/screen-annotation/helper/pair-ticket", "issueScreenAnnotationHelperPairTicket", decode,
		func(ctx context.Context, request helperPairRequest) (helperaccess.LocalTickets, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return helperaccess.LocalTickets{}, apiErrorUnauthenticated
			}
			binding := helperaccess.Binding{
				LayerID: request.layer, PublicationID: request.body.PublicationID, DeviceKey: request.body.HelperPublicKey,
			}
			return service.IssueLocal(ctx, subject, binding, request.origin, request.body.Challenge, request.body.Remembered)
		}).
		Auth(APIAuthParticipantMedia).
		Needs(service).
		Middleware(noStoreResponses).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("ScreenAnnotationHelperPairRequest", helperPairBody{}).
		Responds(http.StatusOK, "ScreenAnnotationHelperPairResponse", helperaccess.LocalTickets{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorRateLimited, apiErrorServiceUnavailable).
		ErrorRules(errorRules{ruleFor(apiErrorInvalidRequest, helperaccess.ErrInvalid), ruleFor(apiErrorForbidden, helperaccess.ErrShareNotCurrent)})
}
