package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func episodeDiagnosticCreateExportHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "export")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		var request diagnosticExportRequest
		if err := decodeEpisodeDiagnosticsJSON(w, r, &request); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		if request.SchemaVersion != "ExportJobRequest/v1" {
			writeEpisodeDiagnosticsError(w, errors.New("invalid export request version"))
			return
		}
		cursorFrom := int64(0)
		if request.CursorTo != nil && (*request.CursorTo < cursorFrom || *request.CursorTo > episodediagnostics.MaxCursor) {
			writeEpisodeDiagnosticsError(w, errors.New("export cursor range is invalid"))
			return
		}
		job, err := options.Service.CreateExport(r.Context(), operator, reference, cursorFrom, request.CursorTo)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job)
	}
}

func episodeDiagnosticExportStatusHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "export")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		jobID, err := diagnosticJobIDFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		job, err := options.Service.Export(r.Context(), operator, reference, jobID)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func episodeDiagnosticCancelExportHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "export")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		jobID, err := diagnosticJobIDFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		job, err := options.Service.CancelExport(r.Context(), operator, reference, jobID)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, job)
	}
}

func episodeDiagnosticDownloadHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Export artifacts and signed redirects are operator-scoped and may
		// contain sensitive diagnostic evidence. Set this before authentication
		// or any other response path so errors cannot be cached either.
		w.Header().Set("Cache-Control", "private, no-store")
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "export")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		jobID, err := diagnosticJobIDFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		job, err := options.Service.Export(r.Context(), operator, reference, jobID)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		if strings.TrimSpace(job.DownloadURL) != "" {
			http.Redirect(w, r, job.DownloadURL, http.StatusFound)
			return
		}
		artifact, artifactErr := options.Service.Download(r.Context(), operator, reference, jobID)
		if artifactErr != nil {
			writeEpisodeDiagnosticsError(w, artifactErr)
			return
		}
		if artifact.Size > 0 && len(artifact.Data) == 0 {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrExportNotReady)
			return
		}
		contentType := strings.TrimSpace(artifact.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		filename := "episode-diagnostic-" + jobID + ".json"
		objectKey := strings.ToLower(strings.TrimSpace(artifact.ObjectKey))
		switch {
		case strings.HasSuffix(objectKey, ".json.gz"), strings.HasSuffix(objectKey, ".ndjson.gz"):
			filename += ".gz"
		case strings.HasSuffix(objectKey, ".zip"):
			filename = "episode-diagnostic-" + jobID + ".zip"
		case strings.Contains(strings.ToLower(contentType), "gzip"):
			filename += ".gz"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		if artifact.Checksum != "" {
			w.Header().Set("X-Chalk-Diagnostic-Checksum", artifact.Checksum)
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(artifact.Data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(artifact.Data)
	}
}

func diagnosticJobIDFromRequest(r *http.Request) (string, error) {
	jobID := strings.TrimSpace(chi.URLParam(r, "jobID"))
	if jobID == "" {
		jobID = strings.TrimSpace(r.URL.Query().Get("job_id"))
	}
	if jobID == "" || len(jobID) > 128 || !episodediagnostics.SafeOpaqueID(jobID) {
		return "", episodediagnostics.ErrExportNotFound
	}
	return jobID, nil
}
