package httpapi

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/mcptools"
)

func bindMCPArtifactTools(server *mcp.Server, o Options) {
	mcptools.Bind(server, mcptools.InspectRecordings, func(ctx context.Context, i mcptools.RecordingsViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.View {
		case "recording":
			return mcpInvoke(b, getRecordingEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), getRecordingRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID)})
		case "download_url":
			return mcpInvoke(b, createRecordingDownloadURLEndpoint(o.Recordings, o.RecordingExports, o.RecordingDownloads, o.TenantAuthz), createRecordingDownloadURLEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID), Body: createRecordingDownloadURLRequest{ExpiresInSeconds: i.ExpiresInSeconds, Download: i.Download}})
		default:
			return mcpInvoke(b, listRecordingsEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), listRecordingsRequest{TenantID: b.tenant, SpaceID: b.optionalID(i.SpaceID), EpisodeID: b.optionalID(i.EpisodeID), Page: b.page(i.PageInput)})
		}
	})
	bindMCPEndpoint(server, mcptools.ExportRecording, requestRecordingExportEndpoint(o.Recordings, o.RecordingExports, o.TenantAuthz), func(b *mcpRequest, i mcptools.RecordingInput) requestRecordingExportEndpointRequest {
		return requestRecordingExportEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID)}
	})
	mcptools.Bind(server, mcptools.InspectTranscripts, func(ctx context.Context, i mcptools.TranscriptViewInput) (json.RawMessage, error) {
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
	bindMCPEndpoint(server, mcptools.RequestTranscript, requestTranscriptEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcptools.TranscriptRequestInput) requestTranscriptEndpointRequest {
		return requestTranscriptEndpointRequest{TenantID: b.tenant, RecordingID: b.id(i.RecordingID), Body: requestTranscriptBody{IdempotencyKey: i.RequestKey, Language: i.Language, Languages: i.Languages}}
	})
	bindMCPEndpoint(server, mcptools.DeleteTranscript, deleteTranscriptArtifactEndpoint(o.TranscriptArtifacts, o.TenantAuthz), func(b *mcpRequest, i mcptools.TranscriptIDInput) deleteTranscriptRequest {
		return deleteTranscriptRequest{TenantID: b.tenant, TranscriptID: b.id(i.TranscriptID)}
	})
}
