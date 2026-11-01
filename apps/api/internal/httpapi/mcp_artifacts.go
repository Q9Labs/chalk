package httpapi

import (
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPArtifactTools(server *mcpapi.Server, o Options) {
	bindMCPEndpoint(server, mcpapi.ListRecordings, listRecordingsEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), func(b *mcpRequest, i mcpapi.RecordingsInput) listRecordingsRequest {
		return listRecordingsRequest{TenantID: b.tenant, SpaceID: b.optionalID(i.SpaceID), EpisodeID: b.optionalID(i.EpisodeID), Page: b.page(i.PageInput)}
	})
	bindMCPEndpoint(server, mcpapi.GetRecording, getRecordingEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), func(b *mcpRequest, i mcpapi.RecordingInput) getRecordingRequest {
		return getRecordingRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID)}
	})
	bindMCPEndpoint(server, mcpapi.GetRecordingDownload, createRecordingDownloadURLEndpoint(o.Recordings, o.RecordingExports, o.RecordingDownloads, o.TenantAuthz), func(b *mcpRequest, i mcpapi.RecordingDownloadInput) createRecordingDownloadURLEndpointRequest {
		return createRecordingDownloadURLEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID), Body: createRecordingDownloadURLRequest{ExpiresInSeconds: i.ExpiresInSeconds, Download: i.Download}}
	})
	bindMCPEndpoint(server, mcpapi.ExportRecording, requestRecordingExportEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), func(b *mcpRequest, i mcpapi.RecordingInput) requestRecordingExportEndpointRequest {
		return requestRecordingExportEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID)}
	})
	bindMCPEndpoint(server, mcpapi.ListTranscripts, listTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcpapi.TranscriptsInput) listTranscriptsRequest {
		return listTranscriptsRequest{TenantID: b.tenant, RecordingID: b.optionalID(i.RecordingID), Page: b.page(i.PageInput)}
	})
	bindMCPEndpoint(server, mcpapi.DeleteTranscript, deleteTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcpapi.TranscriptInput) deleteTranscriptRequest {
		return deleteTranscriptRequest{TenantID: b.tenant, TranscriptID: b.id(i.TranscriptID)}
	})
}
