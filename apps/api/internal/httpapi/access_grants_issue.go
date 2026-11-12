package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// accessGrantIssuer holds the services an access grant request needs.
type accessGrantIssuer struct {
	refresh       SyncTokenRefreshIssuer
	mediaIssuer   ParticipantMediaIssuer
	mediaVerifier ParticipantMediaVerifier
	active        ActiveParticipantAuthorizer
	generations   ParticipantGenerationAuthorizer
	spaces        SpaceService
	tenants       TenantService
	mediaResolver MediaPlaneResolver
	authorizer    TenantAuthorizer
}

// mediaReservation records a held replacement media connection so a failed
// request can hand the participant's media connection back.
type mediaReservation struct {
	original accessgrants.Subject
	held     accessgrants.Subject
}

// accessGrantFlow is the state of one access grant request. stage names the
// step that is running, so a failure is logged against the step that caused it.
type accessGrantFlow struct {
	accessGrantIssuer
	request      issueAccessGrantRequest
	stage        string
	key          synctokens.SubjectKey
	currentToken string
	// replace is true when the request moves the participant to a new media
	// connection; conditional is true when it does so only if the caller's
	// expected connection is still current.
	replace     bool
	conditional bool
	subject     accessgrants.Subject
	previous    accessgrants.Subject
	reserved    *mediaReservation
}

func (i accessGrantIssuer) issue(ctx context.Context, request issueAccessGrantRequest) (accessGrantResponse, error) {
	flow := &accessGrantFlow{
		accessGrantIssuer: i,
		request:           request,
		stage:             "tenant_authorization",
		key:               synctokens.SubjectKey{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID},
		currentToken:      strings.TrimSpace(request.Body.CurrentMediaToken),
		replace:           request.Body.ReplaceMediaConnection,
		conditional:       request.Body.ReplaceMediaConnection && request.Body.ExpectedMediaConnectionID != nil,
	}
	return flow.run(ctx)
}

func (f *accessGrantFlow) run(ctx context.Context) (_ accessGrantResponse, failure error) {
	defer func() {
		if failure != nil {
			observability.LogAccessGrantFailure(ctx, f.stage, episodeLifecycleRules.apiError(failure).Code)
		}
	}()
	defer f.releaseReservation(ctx, &failure)

	if err := authorizeTenant(ctx, f.authorizer, f.request.TenantID, writeEpisodesPermission); err != nil {
		return accessGrantResponse{}, err
	}
	if err := f.validate(); err != nil {
		return accessGrantResponse{}, err
	}
	if err := f.verifyCurrentToken(ctx); err != nil {
		return accessGrantResponse{}, err
	}
	if err := f.authorizeParticipant(ctx); err != nil {
		return accessGrantResponse{}, err
	}
	if err := f.resolvePrevious(); err != nil {
		return accessGrantResponse{}, err
	}
	replayed := (f.replace && !f.request.Body.ReplaceMediaConnection) || f.conditional
	if replayed {
		cached, done, err := f.replayRefresh(ctx)
		if err != nil || done {
			return cached, err
		}
	}
	join, err := f.connect(ctx)
	if err != nil {
		return accessGrantResponse{}, err
	}
	return f.complete(ctx, join, replayed)
}

func (f *accessGrantFlow) validate() error {
	f.stage = "request"
	if f.refresh == nil || f.mediaIssuer == nil || f.mediaVerifier == nil || f.active == nil || f.generations == nil {
		return apiErrorServiceUnavailable
	}
	if f.request.Body.ParticipantGeneration <= 0 {
		return apiErrorInvalidRequest
	}
	return nil
}

// verifyCurrentToken reads the participant's current media token. An expired
// token still names the participant, and turns the request into a replacement.
func (f *accessGrantFlow) verifyCurrentToken(ctx context.Context) error {
	if f.replace && !f.conditional {
		return nil
	}
	f.stage = "media_token"
	if f.currentToken == "" {
		return apiErrorMediaTokenRequired
	}
	subject, err := f.mediaVerifier.Verify(observability.ContextWithAccessGrantRefresh(ctx), f.currentToken)
	if err != nil && !errors.Is(err, accessgrants.ErrExpired) {
		return accessGrantRefreshError(err)
	}
	f.subject = subject
	f.replace = f.replace || errors.Is(err, accessgrants.ErrExpired)
	if routeErr := accessgrants.RequireRouteSubject(subject, accessgrants.RouteSubject{
		TenantID: f.request.TenantID, SpaceID: f.request.SpaceID, EpisodeID: f.request.EpisodeID,
		ParticipantID: f.request.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration,
		Provider: subject.Provider, ProviderSubject: subject.ProviderSubject,
		ConnectionID: subject.ConnectionID,
	}); routeErr != nil {
		return accessGrantRefreshError(routeErr)
	}
	if subject.ParticipantGeneration != f.request.Body.ParticipantGeneration {
		return apiErrorParticipantGenerationMismatch
	}
	return nil
}

func (f *accessGrantFlow) authorizeParticipant(ctx context.Context) error {
	f.stage = "participant_authorization"
	var (
		isActive bool
		err      error
	)
	if f.replace {
		isActive, err = f.generations.AuthorizeActiveParticipantGeneration(ctx, f.key, f.request.Body.ParticipantGeneration)
	} else {
		isActive, err = f.active.AuthorizeActiveParticipant(ctx, f.subject)
	}
	if err != nil {
		return accessGrantRefreshError(err)
	}
	if !isActive {
		return apiErrorForbidden
	}
	return nil
}

// resolvePrevious sets the connection a replacement moves away from. A
// conditional replacement must name the connection that is still current.
func (f *accessGrantFlow) resolvePrevious() error {
	f.previous = f.subject
	if !f.conditional {
		return nil
	}
	expected := strings.TrimSpace(*f.request.Body.ExpectedMediaConnectionID)
	if expected == "" {
		return apiErrorInvalidRequest
	}
	if f.subject.ConnectionID != expected {
		return accessGrantRefreshError(accessgrants.ErrConnectionSuperseded)
	}
	previous, err := accessGrantSubjectForJoin(f.request, mediaplane.Join{Provider: mediaplane.Provider(f.subject.Provider), ClientPayload: map[string]any{"connectionId": expected}})
	if err != nil {
		return err
	}
	f.previous = previous
	return nil
}

// replayRefresh serves a repeated replacement from the stored response. When
// done is true the cached response is the answer. Otherwise the flow goes on,
// holding either a fresh reservation or the renewed winning connection.
func (f *accessGrantFlow) replayRefresh(ctx context.Context) (cached accessGrantResponse, done bool, err error) {
	f.subject = f.previous
	f.stage = "media_replay"
	requestHash := accessgrants.RefreshRequestHash(f.currentToken)
	stored, err := f.generations.LoadParticipantMediaRefresh(ctx, f.subject, requestHash)
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	if stored == nil {
		return accessGrantResponse{}, false, f.reserveReplacement(ctx, requestHash)
	}
	if !stored.CreatedAt.Add(accessgrants.RefreshReplayWindow).After(time.Now()) {
		return accessGrantResponse{}, false, accessGrantRefreshError(accessgrants.ErrConnectionSuperseded)
	}
	cached, valid, err := decodeAccessGrantReplay(f.currentToken, stored.Ciphertext)
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	if valid {
		return cached, true, nil
	}
	// Expired cached credentials can renew on the winning connection.
	renewed, err := accessGrantSubjectForJoin(f.request, mediaplane.Join{Provider: mediaplane.Provider(f.subject.Provider), ClientPayload: cached.Media.ClientPayload})
	if err != nil {
		return accessGrantResponse{}, false, err
	}
	f.subject, f.previous, f.replace = renewed, renewed, false
	return accessGrantResponse{}, false, nil
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
