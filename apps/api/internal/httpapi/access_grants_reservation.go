package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// mediaReservation records a held replacement media connection so a failed
// request can hand the participant's media connection back.
type mediaReservation struct {
	original accessgrants.Subject
	held     accessgrants.Subject
}

func (f *accessGrantFlow) reserveReplacement(ctx context.Context, requestHash [32]byte) error {
	f.stage = "media_binding"
	reservation := f.previous
	var err error
	if f.conditional {
		reservation.ConnectionID = fmt.Sprintf("replacement:%x", requestHash)
		err = f.generations.ReserveParticipantMediaRefresh(ctx, f.previous, reservation, requestHash)
	} else {
		reservationID, idErr := utilities.NewID()
		if idErr != nil {
			return idErr
		}
		reservation.ConnectionID = "replacement:" + reservationID.String()
		err = f.generations.ReplaceParticipantMediaConnection(ctx, f.previous, reservation)
	}
	if err != nil {
		return accessGrantRefreshError(err)
	}
	f.reserved = &mediaReservation{original: f.previous, held: reservation}
	f.previous = reservation
	return nil
}

// releaseReservation hands the media connection back when the request fails
// after it reserved a replacement.
func (f *accessGrantFlow) releaseReservation(ctx context.Context, failure *error) {
	if f.reserved == nil || *failure == nil {
		return
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	err := f.generations.ReplaceParticipantMediaConnection(cleanup, f.reserved.held, f.reserved.original)
	if err != nil && !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
		*failure = errors.Join(*failure, fmt.Errorf("release media refresh reservation: %w", err))
	}
}

func (f *accessGrantFlow) connect(ctx context.Context) (mediaplane.Join, error) {
	f.stage = "media_connection"
	if !f.replace {
		return resumeAccessGrantJoin(ctx, f.spaces, f.tenants, f.mediaResolver, f.request, f.subject)
	}
	join, err := createAccessGrantJoin(ctx, f.spaces, f.tenants, f.mediaResolver, f.request)
	if err != nil {
		return join, err
	}
	f.subject, err = accessGrantSubjectForJoin(f.request, join)
	return join, err
}

func (f *accessGrantFlow) complete(ctx context.Context, join mediaplane.Join, replayed bool) (accessGrantResponse, error) {
	f.stage = "sync_credential"
	syncCredential, err := f.refresh.IssueForParticipant(ctx, f.key)
	if err != nil {
		return accessGrantResponse{}, err
	}
	f.stage = "media_credential"
	mediaCredential, err := f.mediaIssuer.Issue(observability.ContextWithAccessGrantClientProviders(ctx, f.request.MediaClients), f.subject)
	if err != nil {
		return accessGrantResponse{}, err
	}
	response := newAccessGrantResponse(f.subject, syncCredential, mediaCredential, join)
	f.stage = "media_binding"
	if err := f.commitBinding(ctx, response, replayed); err != nil {
		return accessGrantResponse{}, err
	}
	return response, nil
}

func (f *accessGrantFlow) commitBinding(ctx context.Context, response accessGrantResponse, replayed bool) error {
	switch {
	case replayed:
		body, err := json.Marshal(response)
		if err != nil {
			return err
		}
		replay, err := accessgrants.SealRefreshReplay(f.currentToken, body)
		if err != nil {
			return err
		}
		if err := f.generations.CompleteParticipantMediaRefresh(ctx, f.previous, f.subject, replay); err != nil {
			return accessGrantRefreshError(err)
		}
	case f.replace:
		if err := f.generations.BindParticipantMediaConnection(ctx, f.subject); err != nil {
			return accessGrantRefreshError(err)
		}
	}
	return nil
}
