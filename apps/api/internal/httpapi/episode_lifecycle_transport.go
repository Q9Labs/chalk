package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeCreateEpisodeRequest(r *http.Request) (createEpisodeEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createEpisodeEndpointRequest{}, err
	}
	spaceID, err := spaceIDRequest(r)
	if err != nil {
		return createEpisodeEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createEpisodeRequest](r)
	if err != nil {
		return createEpisodeEndpointRequest{}, err
	}
	return createEpisodeEndpointRequest{TenantID: tenantID, SpaceID: spaceID, RequestKey: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}

type listEpisodesRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Page     pagination.PageRequest
}

func decodeListEpisodesRequest(r *http.Request) (listEpisodesRequest, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return listEpisodesRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listEpisodesRequest{}, paginationAPIError(err)
	}
	return listEpisodesRequest{TenantID: tenantID, SpaceID: spaceID, Page: page}, nil
}

type getEpisodeRequest struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
}

func decodeGetEpisodeRequest(r *http.Request) (getEpisodeRequest, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(r)
	if err != nil {
		return getEpisodeRequest{}, err
	}
	return getEpisodeRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID}, nil
}

func decodeIssueSyncTokenRequest(r *http.Request) (issueSyncTokenEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(r)
	if err != nil {
		return issueSyncTokenEndpointRequest{}, err
	}
	return issueSyncTokenEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID}, nil
}

func decodeAdmitParticipantRequest(r *http.Request) (admitParticipantEndpointRequest, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(r)
	if err != nil {
		return admitParticipantEndpointRequest{}, err
	}
	body, err := decodeJSONBody[admitParticipantRequest](r)
	if err != nil {
		return admitParticipantEndpointRequest{}, err
	}
	participantID := utilities.ID{}
	if body.ParticipantID != "" {
		participantID, err = utilities.ParseID(body.ParticipantID)
		if err != nil {
			return admitParticipantEndpointRequest{}, apiErrorInvalidParticipantID
		}
	}
	identityID := utilities.ID{}
	if body.IdentityID != "" {
		identityID, err = utilities.ParseID(body.IdentityID)
		if err != nil {
			return admitParticipantEndpointRequest{}, apiErrorInvalidRequest
		}
	}
	return admitParticipantEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RequestKey: r.Header.Get(idempotencyKeyHeader), ParticipantID: participantID, IdentityID: identityID, Body: body}, nil
}

func decodeRemoveParticipantRequest(r *http.Request) (removeParticipantEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(r)
	if err != nil {
		return removeParticipantEndpointRequest{}, err
	}
	body, err := decodeJSONBody[removeParticipantRequest](r)
	if err != nil {
		return removeParticipantEndpointRequest{}, err
	}
	return removeParticipantEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RequestKey: r.Header.Get(idempotencyKeyHeader), ParticipantID: participantID, Body: body}, nil
}

func decodeEndEpisodeRequest(r *http.Request) (endEpisodeEndpointRequest, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(r)
	if err != nil {
		return endEpisodeEndpointRequest{}, err
	}
	return endEpisodeEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RequestKey: r.Header.Get(idempotencyKeyHeader)}, nil
}

func decodeSetDeadlineRequest(r *http.Request) (setDeadlineEndpointRequest, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(r)
	if err != nil {
		return setDeadlineEndpointRequest{}, err
	}
	body, err := decodeJSONBody[setDeadlineRequest](r)
	if err != nil {
		return setDeadlineEndpointRequest{}, err
	}
	return setDeadlineEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RequestKey: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}

func idempotencyKeyParameter() APIParameterContract {
	return APIParameterContract{Name: idempotencyKeyHeader, In: "header", Type: "string", Required: true, Pattern: `^[A-Za-z0-9_-]+$`, MinLength: 16, MaxLength: 128}
}

func participantIDParameter() APIParameterContract {
	return APIParameterContract{Name: "participant_id", In: "path", Type: "string", Required: true}
}
