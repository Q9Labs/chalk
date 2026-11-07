package httpapi

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPArtifactTools(server *mcp.Server, o Options) {
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
	mcpapi.Bind(server, mcpapi.InspectTranscripts, func(ctx context.Context, i mcpapi.TranscriptViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		ref := transcriptDocumentRequest{TenantID: b.tenant, TranscriptID: b.optionalID(i.TranscriptID)}
		switch i.View {
		case "metadata":
			return mcpInvoke(b, getTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), getTranscriptRequest(ref))
		case "text":
			return mcpInvoke(b, transcriptTextEndpoint(o.TranscriptArtifacts, o.RecordingObjects, o.TranscriptTextMetadata, o.TenantAuthz), ref)
		case "document":
			return mcpInvoke(b, transcriptDocumentEndpoint(o.TranscriptArtifacts, o.RecordingObjects, o.TenantAuthz), ref)
		case "download_url":
			return mcpInvoke(b, transcriptArtifactDownloadEndpoint(o.TranscriptArtifacts, o.RecordingDownloads, o.TenantAuthz), createTranscriptDownloadRequest{TenantID: ref.TenantID, TranscriptID: ref.TranscriptID, Body: createTranscriptDownloadBody{ExpiresInSeconds: i.ExpiresInSeconds}})
		default:
			return mcpInvoke(b, listTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), listTranscriptsRequest{TenantID: b.tenant, RecordingID: b.optionalID(i.RecordingID), Page: b.page(i.PageInput)})
		}
	})
	bindMCPEndpoint(server, mcpapi.RequestTranscript, requestTranscriptEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcpapi.TranscriptRequestInput) requestTranscriptEndpointRequest {
		return requestTranscriptEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID), Body: requestTranscriptBody{IdempotencyKey: i.RequestKey, Language: i.Language, Languages: i.Languages}}
	})
	bindMCPEndpoint(server, mcpapi.DeleteTranscript, deleteTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcpapi.TranscriptIDInput) deleteTranscriptRequest {
		return deleteTranscriptRequest{TenantID: b.tenant, TranscriptID: b.id(i.TranscriptID)}
	})
}
