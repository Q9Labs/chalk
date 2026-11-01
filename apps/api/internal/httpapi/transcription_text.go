package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TranscriptTextMetadataService interface {
	GetTextMetadata(context.Context, utilities.ID, utilities.ID) (transcripts.TextMetadata, error)
}

type transcriptTextResponse struct {
	text        string
	disposition string
}

func transcriptTextEndpoint(service TranscriptArtifactService, objects RecordingObjectService, metadata TranscriptTextMetadataService, authorizer TenantAuthorizer) Endpoint[transcriptDocumentRequest, transcriptTextResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts/{transcript_id}/text", "/tenants/{tenant_id}/transcripts/{transcript_id}/text", "getTranscriptText", decodeTranscriptDocumentRequest, func(ctx context.Context, request transcriptDocumentRequest) (transcriptTextResponse, error) {
		if metadata == nil {
			return transcriptTextResponse{}, apiErrorServiceUnavailable
		}
		_, document, err := readTranscriptDocument(ctx, service, objects, authorizer, request)
		if err != nil {
			return transcriptTextResponse{}, err
		}
		info, err := metadata.GetTextMetadata(ctx, request.TenantID, request.TranscriptID)
		if err != nil {
			return transcriptTextResponse{}, err
		}
		return transcriptTextResponse{
			text:        transcripts.FormatText(document, info),
			disposition: transcriptTextDisposition(info.SpaceTitle, info.StartedAt),
		}, nil
	}).Auth(APIAuthCookieOrBearer).Parameters(tenantIDParameter(), transcriptIDParameter()).
		Description("Download a UTF-8 transcript with a Space title, UTC recording date, duration, detected language when known, and recording-relative speaker lines. Requires transcriptions:read.").
		RespondsText(http.StatusOK, "TranscriptText").ResponseHeaders(APIHeaderContract{Name: "Content-Disposition", Type: "string", Required: true}).
		Errors(transcriptReadErrors(apiErrorInvalidTranscriptID, apiErrorTranscriptNotFound, apiErrorTranscriptNotReady, apiErrorRecordingArtifactNotFound)...).
		MapErrors(transcriptDocumentAPIError).WriteWith(writeTranscriptText)
}

func writeTranscriptText(w http.ResponseWriter, _ *http.Request, status int, response transcriptTextResponse) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", response.disposition)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(response.text))
}

func transcriptTextDisposition(title string, startedAt time.Time) string {
	var ascii strings.Builder
	for _, r := range title {
		if ascii.Len() >= 100 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			ascii.WriteRune(r)
		} else if ascii.Len() > 0 && !strings.HasSuffix(ascii.String(), "-") {
			ascii.WriteByte('-')
		}
	}
	base := strings.Trim(ascii.String(), "-")
	if base == "" {
		base = "transcript"
	}
	suffix := "-" + startedAt.UTC().Format("2006-01-02") + ".txt"
	disposition := fmt.Sprintf(`attachment; filename="%s%s"`, base, suffix)
	if !isASCII(title) {
		runes := []rune(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) || strings.ContainsRune(`/\":`, r) {
				return '-'
			}
			return r
		}, title))
		if len(runes) > 100 {
			runes = runes[:100]
		}
		filename := strings.Trim(string(runes), " .-") + suffix
		disposition += "; filename*=UTF-8''" + strings.ReplaceAll(url.QueryEscape(filename), "+", "%20")
	}
	return disposition
}

func isASCII(value string) bool {
	for _, r := range value {
		if r > unicode.MaxASCII {
			return false
		}
	}
	return true
}
