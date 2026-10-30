package httpapi

import (
	"github.com/q9labs/chalk/features/whiteboard/api"
	"github.com/q9labs/chalk/platform/httpcontract"
)

func PreviewRouteContracts() []httpcontract.APIRouteContract {
	endpoints := make([]RouteEndpoint, 0)
	endpoints = append(endpoints, problemReportEndpoints(nil, nil, RateLimitOptions{})...)
	endpoints = append(endpoints, cancelParticipantJoinEndpoint(nil, nil))
	endpoints = append(endpoints, participantEpisodeStatusEndpoint(nil, nil))
	endpoints = append(endpoints, connectionReportEndpoint(nil))
	endpoints = append(endpoints, tenantEndpoints(nil, nil)...)

	endpoints = append(endpoints, membershipEndpoints(nil, nil)...)

	endpoints = append(endpoints, spaceEndpoints(nil, nil)...)
	endpoints = append(endpoints, recordingPreparationEndpoints(nil, nil)...)
	endpoints = append(endpoints, recordingEntranceEndpoints(nil, nil, nil, nil)...)
	endpoints = append(endpoints, apiKeyEndpoints(nil, nil)...)
	endpoints = append(endpoints, episodeLifecycleEndpoints(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)...)
	endpoints = append(endpoints, sfuSignalingEndpoints(nil, nil, nil, nil, nil)...)
	endpoints = append(endpoints, chatAttachmentEndpoints(nil, nil)...)
	endpoints = append(endpoints, FromSpec(whiteboardfiles.FileEndpoint(nil, nil)))
	endpoints = append(endpoints, recordingEndpoints(nil, nil, nil, nil)...)
	endpoints = append(endpoints, transcriptArtifactEndpoints(nil, nil, nil, nil)...)

	endpoints = append(endpoints, webhookEndpoints(nil, nil)...)
	endpoints = append(endpoints, publicInviteEndpoints(nil, nil)...)
	return routeContracts(endpoints)
}

func routeContracts(endpoints []RouteEndpoint) []httpcontract.APIRouteContract {
	contracts := make([]httpcontract.APIRouteContract, 0, len(endpoints))
	for _, endpoint := range endpoints {
		contracts = append(contracts, endpoint.RouteContract())
	}
	return contracts
}
