package postgres

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

const (
	maxDiagnosticExportPayloadBytes = 32 << 20
	maxDiagnosticExportTotalBytes   = 128 << 20
	diagnosticExportChunkBytes      = 8 << 20
	diagnosticExportPageLimit       = int32(100)
)

type diagnosticExportChunkWriter struct {
	ctx        context.Context
	queries    *sqlc.Queries
	tenantID   pgtype.UUID
	diagnostic pgtype.UUID
	jobID      pgtype.UUID
	leaseToken pgtype.UUID
	buffer     bytes.Buffer
	total      int64
	partIndex  int32
	totalHash  hash.Hash
}

func newDiagnosticExportChunkWriter(ctx context.Context, queries *sqlc.Queries, job sqlc.DiagnosticExportJob, leaseToken pgtype.UUID) *diagnosticExportChunkWriter {
	return &diagnosticExportChunkWriter{ctx: ctx, queries: queries, tenantID: job.TenantID, diagnostic: job.DiagnosticID, jobID: job.ID, leaseToken: leaseToken, totalHash: sha256.New()}
}

func (w *diagnosticExportChunkWriter) Write(value []byte) (int, error) {
	if len(value) == 0 {
		return 0, nil
	}
	if w.total+int64(len(value)) > maxDiagnosticExportTotalBytes {
		return 0, errors.New("diagnostic export exceeds total compressed payload limit")
	}
	if _, err := w.totalHash.Write(value); err != nil {
		return 0, err
	}
	w.total += int64(len(value))
	written := 0
	for written < len(value) {
		remaining := diagnosticExportChunkBytes - w.buffer.Len()
		count := len(value) - written
		if count > remaining {
			count = remaining
		}
		_, _ = w.buffer.Write(value[written : written+count])
		written += count
		if w.buffer.Len() == diagnosticExportChunkBytes {
			if err := w.flush(); err != nil {
				return written, err
			}
		}
	}
	return len(value), nil
}

func (w *diagnosticExportChunkWriter) flush() error {
	if w.buffer.Len() == 0 {
		return nil
	}
	chunk := append([]byte(nil), w.buffer.Bytes()...)
	digest := sha256.Sum256(chunk)
	if err := w.queries.InsertDiagnosticExportArtifactChunk(w.ctx, sqlc.InsertDiagnosticExportArtifactChunkParams{
		TenantID: w.tenantID, DiagnosticID: w.diagnostic, JobID: w.jobID, PartIndex: w.partIndex,
		Payload: chunk, Checksum: hex.EncodeToString(digest[:]), ByteSize: int64(len(chunk)), LeaseToken: w.leaseToken,
	}); err != nil {
		return fmt.Errorf("persist diagnostic export chunk %d: %w", w.partIndex, err)
	}
	w.partIndex++
	w.buffer.Reset()
	return nil
}

func (w *diagnosticExportChunkWriter) Close() error { return w.flush() }

func (w *diagnosticExportChunkWriter) checksum() string {
	return "sha256:" + hex.EncodeToString(w.totalHash.Sum(nil))
}

type diagnosticBundleManifest struct {
	SchemaVersion string            `json:"schemaVersion"`
	Reference     string            `json:"reference"`
	CursorFrom    int64             `json:"cursorFrom"`
	CursorTo      int64             `json:"cursorTo"`
	EventCount    int64             `json:"eventCount"`
	OmissionCount int64             `json:"omissionCount"`
	Checksums     map[string]string `json:"checksums"`
	Compressed    bool              `json:"compressed"`
	SplitParts    int               `json:"splitParts,omitempty"`
}

type diagnosticBundleHeader struct {
	SchemaVersion string `json:"schemaVersion"`
	Reference     string `json:"reference"`
	CursorFrom    int64  `json:"cursorFrom"`
	CursorTo      int64  `json:"cursorTo"`
}

type diagnosticExportJSONStream struct {
	writer       io.Writer
	firstElement map[string]bool
	hashes       map[string]hash.Hash
}

func (s *diagnosticExportJSONStream) arrayValue(name string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if !s.firstElement[name] {
		if _, err := io.WriteString(s.writer, ","); err != nil {
			return err
		}
	}
	s.firstElement[name] = false
	if _, err := s.hashes[name].Write(encoded); err != nil {
		return err
	}
	_, err = s.writer.Write(encoded)
	return err
}

func (s *diagnosticExportJSONStream) checksums() map[string]string {
	result := make(map[string]string, len(s.hashes))
	for name, digest := range s.hashes {
		result[name] = "sha256:" + hex.EncodeToString(digest.Sum(nil))
	}
	return result
}

func (r *EpisodeDiagnosticsRepository) CreateExport(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, operator episodediagnostics.OperatorPrincipal, cursorFrom int64, cursorTo *int64, leaseEndsAt time.Time) (episodediagnostics.DiagnosticExportJob, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticExportJob{}, errDiagnosticsUnavailable
	}
	if cursorTo == nil {
		frozen := diagnostic.CommittedCursor
		cursorTo = &frozen
	}
	if cursorFrom < 0 || cursorFrom > episodediagnostics.MaxCursor || cursorTo != nil && (*cursorTo < cursorFrom || *cursorTo > episodediagnostics.MaxCursor) {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("invalid diagnostic export cursor range")
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrNotFound
	}
	queries := sqlc.New(r.queryPool)
	total, err := queries.CountDiagnosticEvents(ctx, sqlc.CountDiagnosticEventsParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), CursorFrom: cursorFrom, CursorTo: diagnosticOptionalInt8(cursorTo)})
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("count diagnostic export events: %w", err)
	}
	jobID, err := utilities.NewID()
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("generate diagnostic export job id: %w", err)
	}
	if leaseEndsAt.IsZero() {
		leaseEndsAt = time.Now().UTC().Add(episodediagnostics.ExportLease)
	}
	traceID, spanID := pgtype.Text{}, pgtype.Text{}
	if spanContext := trace.SpanContextFromContext(ctx); spanContext.IsValid() {
		traceID = diagnosticText(spanContext.TraceID().String())
		spanID = diagnosticText(spanContext.SpanID().String())
	}
	row, err := queries.CreateDiagnosticExportJob(ctx, sqlc.CreateDiagnosticExportJobParams{
		TenantID:            uuid(tenantID),
		DiagnosticID:        uuid(diagnosticID),
		ID:                  uuid(jobID),
		OperatorSubjectHash: operator.SubjectHash,
		CursorFrom:          cursorFrom,
		CursorTo:            diagnosticOptionalInt8(cursorTo),
		LeaseEndsAt:         timestamptz(&leaseEndsAt),
		TraceID:             traceID,
		SpanID:              spanID,
		TotalEvents:         pgtype.Int8{Int64: total, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrExportQuota
	}
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("create diagnostic export job: %w", err)
	}
	return mapDiagnosticExportJob(row, diagnostic), nil
}

func (r *EpisodeDiagnosticsRepository) GetExport(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, operator episodediagnostics.OperatorPrincipal, jobID utilities.ID) (episodediagnostics.DiagnosticExportJob, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticExportJob{}, errDiagnosticsUnavailable
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil || jobID.IsZero() {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrExportNotFound
	}
	row, err := sqlc.New(r.queryPool).GetDiagnosticExportJobForOperator(ctx, sqlc.GetDiagnosticExportJobForOperatorParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), ID: uuid(jobID), OperatorSubjectHash: operator.SubjectHash})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrExportNotFound
	}
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("get diagnostic export job: %w", err)
	}
	return mapDiagnosticExportJob(row, diagnostic), nil
}

func (r *EpisodeDiagnosticsRepository) CancelExport(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, operator episodediagnostics.OperatorPrincipal, jobID utilities.ID, _ time.Time) (episodediagnostics.DiagnosticExportJob, error) {
	if r.queryPool == nil {
		return episodediagnostics.DiagnosticExportJob{}, errDiagnosticsUnavailable
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil || jobID.IsZero() {
		return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrExportNotFound
	}
	queries := sqlc.New(r.queryPool)
	row, err := queries.CancelDiagnosticExportJobForOperator(ctx, sqlc.CancelDiagnosticExportJobForOperatorParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), ID: uuid(jobID), OperatorSubjectHash: operator.SubjectHash, LeaseToken: pgtype.UUID{}})
	if errors.Is(err, pgx.ErrNoRows) {
		row, getErr := queries.GetDiagnosticExportJobForOperator(ctx, sqlc.GetDiagnosticExportJobForOperatorParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), ID: uuid(jobID), OperatorSubjectHash: operator.SubjectHash})
		if errors.Is(getErr, pgx.ErrNoRows) {
			return episodediagnostics.DiagnosticExportJob{}, episodediagnostics.ErrExportNotFound
		}
		if getErr != nil {
			return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("get diagnostic export job after cancellation race: %w", getErr)
		}
		return mapDiagnosticExportJob(row, diagnostic), nil
	}
	if err != nil {
		return episodediagnostics.DiagnosticExportJob{}, fmt.Errorf("cancel diagnostic export job: %w", err)
	}
	return mapDiagnosticExportJob(row, diagnostic), nil
}

func (r *EpisodeDiagnosticsRepository) ExportArtifact(ctx context.Context, diagnostic episodediagnostics.EpisodeDiagnostic, operator episodediagnostics.OperatorPrincipal, jobID utilities.ID) (episodediagnostics.ExportArtifact, error) {
	if r.queryPool == nil {
		return episodediagnostics.ExportArtifact{}, errDiagnosticsUnavailable
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrNotFound
	}
	diagnosticID, err := utilities.ParseID(diagnostic.ID)
	if err != nil || jobID.IsZero() {
		return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotFound
	}
	row, err := sqlc.New(r.queryPool).GetDiagnosticExportJobForOperator(ctx, sqlc.GetDiagnosticExportJobForOperatorParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), ID: uuid(jobID), OperatorSubjectHash: operator.SubjectHash})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotFound
	}
	if err != nil {
		return episodediagnostics.ExportArtifact{}, fmt.Errorf("get diagnostic export artifact: %w", err)
	}
	if row.State != string(episodediagnostics.ExportSucceeded) || !row.DownloadExpiresAt.Valid || !time.Now().Before(row.DownloadExpiresAt.Time) || !row.ArtifactContentType.Valid || !row.ArtifactChecksum.Valid || !row.ArtifactSize.Valid {
		return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotReady
	}
	payload := append([]byte(nil), row.ArtifactPayload...)
	if len(payload) == 0 {
		chunks, chunkErr := sqlc.New(r.queryPool).ListDiagnosticExportArtifactChunks(ctx, sqlc.ListDiagnosticExportArtifactChunksParams{TenantID: uuid(tenantID), DiagnosticID: uuid(diagnosticID), JobID: uuid(jobID)})
		if chunkErr != nil {
			return episodediagnostics.ExportArtifact{}, fmt.Errorf("list diagnostic export artifact chunks: %w", chunkErr)
		}
		var total int64
		for index, chunk := range chunks {
			if chunk.PartIndex != int32(index) || len(chunk.Payload) == 0 || len(chunk.Payload) > diagnosticExportChunkBytes || chunk.ByteSize != int64(len(chunk.Payload)) {
				return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotReady
			}
			digest := sha256.Sum256(chunk.Payload)
			if chunk.Checksum != hex.EncodeToString(digest[:]) {
				return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotReady
			}
			total += int64(len(chunk.Payload))
			if total > maxDiagnosticExportTotalBytes {
				return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotReady
			}
			payload = append(payload, chunk.Payload...)
		}
	}
	if len(payload) == 0 || int64(len(payload)) != row.ArtifactSize.Int64 || int64(len(payload)) > maxDiagnosticExportTotalBytes || row.ArtifactChecksum.String != episodediagnostics.FingerprintBytes(payload) {
		return episodediagnostics.ExportArtifact{}, episodediagnostics.ErrExportNotReady
	}
	return episodediagnostics.ExportArtifact{ContentType: row.ArtifactContentType.String, ObjectKey: nullableString(row.ObjectKey), Size: row.ArtifactSize.Int64, Checksum: row.ArtifactChecksum.String, Data: payload}, nil
}

func (r *EpisodeDiagnosticsRepository) RunExport(ctx context.Context, owner string) (bool, error) {
	if r.queryPool == nil {
		return false, errDiagnosticsUnavailable
	}
	leaseID, err := utilities.NewID()
	if err != nil {
		return false, fmt.Errorf("generate diagnostic export lease: %w", err)
	}
	claims, err := sqlc.New(r.queryPool).ClaimDiagnosticExportJobs(ctx, sqlc.ClaimDiagnosticExportJobsParams{LeaseToken: uuid(leaseID), LeaseOwner: diagnosticText(owner), LeaseSeconds: diagnosticExportLeaseSeconds, PageLimit: episodediagnostics.DefaultPageSize})
	if err != nil {
		return false, fmt.Errorf("claim diagnostic export jobs: %w", err)
	}
	var firstErr error
	for _, claim := range claims {
		if err := r.runDiagnosticExportJob(ctx, claim, leaseID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return len(claims) > 0, firstErr
}

func (r *EpisodeDiagnosticsRepository) runDiagnosticExportJob(ctx context.Context, job sqlc.DiagnosticExportJob, leaseID utilities.ID) error {
	queries := sqlc.New(r.queryPool)
	// A reclaimed lease starts a fresh artifact. Chunks from the abandoned
	// attempt are hidden from downloads and removed before new output begins.
	if _, err := queries.DeleteDiagnosticExportArtifactChunks(ctx, sqlc.DeleteDiagnosticExportArtifactChunksParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, JobID: job.ID}); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("delete stale export chunks: %w", err))
	}
	rootRow, err := sqlc.New(r.queryPool).GetEpisodeDiagnosticByOpaqueID(ctx, sqlc.GetEpisodeDiagnosticByOpaqueIDParams{TenantID: job.TenantID, ID: job.DiagnosticID})
	if err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("load diagnostic export root: %w", err))
	}
	diagnostic := mapEpisodeDiagnostic(rootRow)
	spanCtx, span := startDiagnosticLinkedSpan(ctx, "episode_diagnostics.export", nullableString(job.TraceID), nullableString(job.SpanID), "export", "bundle")
	defer span.End()
	ctx = spanCtx
	state, _, loadErr := r.loadProjectionState(ctx, queries, diagnostic, episodediagnostics.DiagnosticFilterV1{}, diagnosticProjectorOperationLimit, episodediagnostics.MaxSnapshotIssues, episodediagnostics.MaxSnapshotBranches)
	if loadErr != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("load diagnostic export projections: %w", loadErr))
	}
	effectiveCursorTo := diagnostic.CommittedCursor
	if job.CursorTo.Valid {
		effectiveCursorTo = job.CursorTo.Int64
	}
	header := diagnosticBundleHeader{
		SchemaVersion: "DiagnosticBundle/v1",
		Reference:     diagnosticReference(diagnostic),
		CursorFrom:    job.CursorFrom,
		CursorTo:      effectiveCursorTo,
	}
	chunkWriter := newDiagnosticExportChunkWriter(ctx, queries, job, uuid(leaseID))
	gzipWriter := gzip.NewWriter(chunkWriter)
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export header: %w", err))
	}
	if len(headerBytes) == 0 || headerBytes[len(headerBytes)-1] != '}' {
		return r.failDiagnosticExportJob(ctx, job, leaseID, errors.New("encode diagnostic export header"))
	}
	if _, err := gzipWriter.Write(append(headerBytes[:len(headerBytes)-1], []byte(`,"events":[`)...)); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export header: %w", err))
	}
	stream := &diagnosticExportJSONStream{writer: gzipWriter, firstElement: map[string]bool{"events": true}, hashes: map[string]hash.Hash{"events": sha256.New()}}
	processed := int64(0)
	afterCursor := job.CursorFrom - 1
	lastCursor := job.CursorFrom
	for {
		rows, listErr := queries.ListEventsAfterCursor(ctx, sqlc.ListEventsAfterCursorParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, AfterCursor: afterCursor, PageLimit: diagnosticExportPageLimit})
		if listErr != nil {
			return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export events: %w", listErr))
		}
		if len(rows) == 0 {
			break
		}
		stop := false
		for _, row := range rows {
			afterCursor = row.Cursor
			if row.Cursor < job.CursorFrom {
				continue
			}
			if job.CursorTo.Valid && row.Cursor > job.CursorTo.Int64 {
				stop = true
				break
			}
			if err := stream.arrayValue("events", mapDiagnosticEventForOperator(row)); err != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export event: %w", err))
			}
			processed++
			lastCursor = row.Cursor
		}
		if processed > 0 {
			current := pgtype.Int8{Int64: lastCursor, Valid: true}
			if _, progressErr := queries.UpdateDiagnosticExportProgress(ctx, sqlc.UpdateDiagnosticExportProgressParams{ProcessedEvents: processed, TotalEvents: job.TotalEvents, CurrentCursor: current, LeaseSeconds: diagnosticExportLeaseSeconds, TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, ID: job.ID, LeaseToken: uuid(leaseID)}); progressErr != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("update diagnostic export progress: %w", progressErr))
			}
		}
		if stop || job.CursorTo.Valid && lastCursor >= job.CursorTo.Int64 {
			break
		}
	}
	if _, err := io.WriteString(gzipWriter, `],"operations":[`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export operations: %w", err))
	}
	stream.firstElement["operations"] = true
	stream.hashes["operations"] = sha256.New()
	var operationAfter *int64
	for {
		operationRows, operationErr := queries.ListDiagnosticOperations(ctx, listDiagnosticOperationsParams(diagnostic, episodediagnostics.DiagnosticFilterV1{}, operationAfter, diagnosticExportPageLimit))
		if operationErr != nil {
			return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export operations: %w", operationErr))
		}
		if len(operationRows) == 0 {
			break
		}
		for _, operationRow := range operationRows {
			operation := mapDiagnosticOperation(operationRow, diagnostic)
			checkpoints, checkpointErr := queries.ListDiagnosticCheckpoints(ctx, sqlc.ListDiagnosticCheckpointsParams{TenantID: operationRow.TenantID, DiagnosticID: operationRow.DiagnosticID, OperationID: operationRow.ID})
			if checkpointErr != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export checkpoints: %w", checkpointErr))
			}
			for _, checkpoint := range checkpoints {
				operation.Checkpoints = append(operation.Checkpoints, mapDiagnosticCheckpoint(checkpoint))
			}
			if err := stream.arrayValue("operations", operation); err != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export operation: %w", err))
			}
		}
		last := operationRows[len(operationRows)-1].FirstEvidenceCursor
		if operationAfter != nil && last <= *operationAfter {
			break
		}
		operationAfter = &last
		if len(operationRows) < int(diagnosticExportPageLimit) {
			break
		}
	}
	if _, err := io.WriteString(gzipWriter, `],"issues":[`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export issues: %w", err))
	}
	stream.firstElement["issues"] = true
	stream.hashes["issues"] = sha256.New()
	var issueAfterAt *time.Time
	var issueAfterID pgtype.UUID
	for {
		issueRows, issueErr := queries.ListDiagnosticIssuesAfter(ctx, sqlc.ListDiagnosticIssuesAfterParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, State: pgtype.Text{}, AfterObservedAt: optionalTimePtr(issueAfterAt), AfterIssueID: issueAfterID, PageLimit: diagnosticExportPageLimit})
		if issueErr != nil {
			return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export issues: %w", issueErr))
		}
		if len(issueRows) == 0 {
			break
		}
		for _, issueRow := range issueRows {
			if err := stream.arrayValue("issues", mapDiagnosticIssue(issueRow, diagnostic)); err != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export issue: %w", err))
			}
		}
		last := issueRows[len(issueRows)-1]
		lastTime := timestamp(last.FirstObservedAt).UTC()
		if issueAfterAt != nil && !lastTime.After(*issueAfterAt) && last.ID.Bytes == issueAfterID.Bytes {
			break
		}
		issueAfterAt = &lastTime
		issueAfterID = last.ID
		if len(issueRows) < int(diagnosticExportPageLimit) {
			break
		}
	}
	if _, err := io.WriteString(gzipWriter, `],"branches":[`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export branches: %w", err))
	}
	stream.firstElement["branches"] = true
	stream.hashes["branches"] = sha256.New()
	var branchAfterAt *time.Time
	var branchAfterID pgtype.UUID
	for {
		branchRows, branchErr := queries.ListDiagnosticBranchesAfter(ctx, sqlc.ListDiagnosticBranchesAfterParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, AfterCreatedAt: optionalTimePtr(branchAfterAt), AfterID: branchAfterID, PageLimit: diagnosticExportPageLimit})
		if branchErr != nil {
			return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export branches: %w", branchErr))
		}
		if len(branchRows) == 0 {
			break
		}
		for _, branchRow := range branchRows {
			if err := stream.arrayValue("branches", mapDiagnosticBranch(branchRow, diagnostic)); err != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export branch: %w", err))
			}
		}
		last := branchRows[len(branchRows)-1]
		lastAt := timestamp(last.CreatedAt).UTC()
		if branchAfterAt != nil && !lastAt.After(*branchAfterAt) && last.ID.Bytes == branchAfterID.Bytes {
			break
		}
		branchAfterAt, branchAfterID = &lastAt, last.ID
		if len(branchRows) < int(diagnosticExportPageLimit) {
			break
		}
	}
	if _, err := io.WriteString(gzipWriter, `],"participants":[`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export participants: %w", err))
	}
	stream.firstElement["participants"] = true
	stream.hashes["participants"] = sha256.New()
	var participantAfter pgtype.UUID
	participantOrdinal := 0
	for {
		participantRows, participantErr := queries.ListDiagnosticParticipantsAfter(ctx, sqlc.ListDiagnosticParticipantsAfterParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, AfterParticipantID: participantAfter, PageLimit: diagnosticExportPageLimit})
		if participantErr != nil {
			return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("list diagnostic export participants: %w", participantErr))
		}
		if len(participantRows) == 0 {
			break
		}
		for _, participantRow := range participantRows {
			participantOrdinal++
			if err := stream.arrayValue("participants", mapDiagnosticParticipantAfter(participantRow, participantOrdinal)); err != nil {
				return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export participant: %w", err))
			}
		}
		last := participantRows[len(participantRows)-1]
		if participantAfter.Valid && last.ParticipantID.Bytes == participantAfter.Bytes {
			break
		}
		participantAfter = last.ParticipantID
		if len(participantRows) < int(diagnosticExportPageLimit) {
			break
		}
	}
	snapshot := state.Snapshot(diagnosticReference(diagnostic), time.Now().UTC())
	projections := struct {
		Run      *episodediagnostics.RunProjectionV1      `json:"run,omitempty"`
		Graph    *episodediagnostics.GraphProjectionV1    `json:"graph,omitempty"`
		Flame    *episodediagnostics.FlameProjectionV1    `json:"flame,omitempty"`
		Epilogue *episodediagnostics.EpilogueProjectionV1 `json:"epilogue,omitempty"`
	}{Run: snapshot.Run, Graph: snapshot.Graph, Flame: snapshot.Flame, Epilogue: snapshot.Epilogue}
	if _, err := io.WriteString(gzipWriter, `],"projections":`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export projections: %w", err))
	}
	projectionBytes, err := json.Marshal(projections)
	if err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export projections: %w", err))
	}
	if _, err := gzipWriter.Write(projectionBytes); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write diagnostic export projections: %w", err))
	}
	stream.hashes["projections"] = sha256.New()
	_, _ = stream.hashes["projections"].Write(projectionBytes)
	embeddedManifest := diagnosticBundleManifest{SchemaVersion: "DiagnosticBundle/v1", Reference: diagnosticReference(diagnostic), CursorFrom: job.CursorFrom, CursorTo: effectiveCursorTo, EventCount: processed, OmissionCount: int64(len(snapshot.Omissions)), Checksums: stream.checksums(), Compressed: true}
	manifestBytes, err := json.Marshal(embeddedManifest)
	if err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode embedded diagnostic export manifest: %w", err))
	}
	if _, err := gzipWriter.Write(append([]byte(`,"manifest":`), manifestBytes...)); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("write embedded diagnostic export manifest: %w", err))
	}
	if _, err := io.WriteString(gzipWriter, `}`); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("close diagnostic export bundle: %w", err))
	}
	if err := gzipWriter.Close(); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("compress diagnostic export bundle: %w", err))
	}
	if err := chunkWriter.Close(); err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("persist diagnostic export bundle: %w", err))
	}
	checksums := stream.checksums()
	checksums["payload"] = chunkWriter.checksum()
	manifest, err := json.Marshal(episodediagnostics.DiagnosticExportManifestV1{SchemaVersion: "DiagnosticBundle/v1", Reference: diagnosticReference(diagnostic), CursorFrom: job.CursorFrom, CursorTo: effectiveCursorTo, EventCount: processed, OmissionCount: int64(len(snapshot.Omissions)), Checksums: checksums, Compressed: true, SplitParts: int(chunkWriter.partIndex)})
	if err != nil {
		return r.failDiagnosticExportJob(ctx, job, leaseID, fmt.Errorf("encode diagnostic export manifest: %w", err))
	}
	downloadExpiresAt := time.Now().UTC().Add(episodediagnostics.ExportDownloadLife)
	_, err = queries.CompleteDiagnosticExportJob(ctx, sqlc.CompleteDiagnosticExportJobParams{State: string(episodediagnostics.ExportSucceeded), CursorTo: pgtype.Int8{Int64: effectiveCursorTo, Valid: true}, Manifest: manifest, ObjectKey: diagnosticText("episode-diagnostics/" + diagnostic.ID + "/" + idString(job.ID) + ".json.gz"), DownloadExpiresAt: timestamptz(&downloadExpiresAt), ArtifactPayload: nil, ArtifactContentType: diagnosticText("application/gzip"), ArtifactChecksum: diagnosticText(chunkWriter.checksum()), ArtifactSize: pgtype.Int8{Int64: chunkWriter.total, Valid: true}, TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, ID: job.ID, LeaseToken: uuid(leaseID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodediagnostics.ErrExportNotReady
	}
	if err != nil {
		return fmt.Errorf("complete diagnostic export job: %w", err)
	}
	return nil
}

func (r *EpisodeDiagnosticsRepository) failDiagnosticExportJob(ctx context.Context, job sqlc.DiagnosticExportJob, leaseID utilities.ID, cause error) error {
	if cause == nil {
		return nil
	}
	queries := sqlc.New(r.queryPool)
	_, _ = queries.DeleteDiagnosticExportArtifactChunks(ctx, sqlc.DeleteDiagnosticExportArtifactChunksParams{TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, JobID: job.ID})
	reason := diagnosticExportFailureCode(cause)
	_, err := queries.FailDiagnosticExportJob(ctx, sqlc.FailDiagnosticExportJobParams{ErrorReason: diagnosticText(reason), TenantID: job.TenantID, DiagnosticID: job.DiagnosticID, ID: job.ID, LeaseToken: uuid(leaseID)})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("fail diagnostic export job: %w", err)
	}
	return cause
}

func diagnosticExportFailureCode(cause error) string {
	message := strings.ToLower(cause.Error())
	switch {
	case strings.Contains(message, "exceeds") || strings.Contains(message, "limit"):
		return "payload_limit"
	case strings.Contains(message, "lease") || strings.Contains(message, "no rows"):
		return "lease_lost"
	case strings.Contains(message, "encode") || strings.Contains(message, "marshal") || strings.Contains(message, "compress"):
		return "encode_failed"
	case strings.Contains(message, "persist") || strings.Contains(message, "chunk") || strings.Contains(message, "storage"):
		return "storage_failed"
	case strings.Contains(message, "query") || strings.Contains(message, "list") || strings.Contains(message, "load"):
		return "query_failed"
	default:
		return "unknown"
	}
}

func (r *EpisodeDiagnosticsRepository) Retain(ctx context.Context, now time.Time, limit int) (int, error) {
	if r.queryPool == nil {
		return 0, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	claimID, err := utilities.NewID()
	if err != nil {
		return 0, fmt.Errorf("generate diagnostic retention claim: %w", err)
	}
	claimedUntil := now.Add(time.Duration(diagnosticRetentionClaimSeconds) * time.Second)
	claims, err := sqlc.New(r.queryPool).ClaimExpiredDiagnostics(ctx, sqlc.ClaimExpiredDiagnosticsParams{NowAt: timestamptz(&now), ClaimToken: uuid(claimID), ClaimedUntil: timestamptz(&claimedUntil), PageLimit: int32(limit)})
	if err != nil {
		return 0, fmt.Errorf("claim expired diagnostics: %w", err)
	}
	deleted := 0
	for _, claim := range claims {
		for {
			rows, deleteErr := sqlc.New(r.queryPool).DeleteDiagnosticEventBatch(ctx, sqlc.DeleteDiagnosticEventBatchParams{TenantID: claim.TenantID, DiagnosticID: claim.ID, PageLimit: 10000})
			if deleteErr != nil {
				return deleted, fmt.Errorf("delete expired diagnostic events: %w", deleteErr)
			}
			if rows == 0 {
				break
			}
		}
		var removed sqlc.EpisodeDiagnostic
		err = withDiagnosticTx(ctx, r.queryPool, func(tx pgx.Tx) error {
			queries := sqlc.New(tx)
			if _, err := queries.DeleteDiagnosticProjectionChanges(ctx, sqlc.DeleteDiagnosticProjectionChangesParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic projection changes: %w", err)
			}
			if _, err := queries.DeleteDiagnosticReferences(ctx, sqlc.DeleteDiagnosticReferencesParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic references: %w", err)
			}
			if _, err := queries.DeleteDiagnosticProjectorState(ctx, sqlc.DeleteDiagnosticProjectorStateParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic projector state: %w", err)
			}
			removed, err = queries.DeleteDiagnosticRoot(ctx, sqlc.DeleteDiagnosticRootParams{TenantID: claim.TenantID, DiagnosticID: claim.ID, NowAt: timestamptz(&now), ClaimToken: uuid(claimID)})
			return err
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return deleted, err
		}
		if removed.ID.Valid {
			deleted++
		}
	}
	return deleted, nil
}

func mapDiagnosticExportJob(row sqlc.DiagnosticExportJob, diagnostic episodediagnostics.EpisodeDiagnostic) episodediagnostics.DiagnosticExportJob {
	job := episodediagnostics.DiagnosticExportJob{SchemaVersion: "ExportJob/v1", JobID: idString(row.ID), Reference: diagnosticReference(diagnostic), State: episodediagnostics.ExportJobState(row.State), CreatedAt: timestamp(row.CreatedAt).UTC(), LeaseEndsAt: timestamp(row.LeaseEndsAt).UTC(), CursorFrom: row.CursorFrom, CursorTo: diagnosticCursorValue(row.CursorTo), ErrorReason: nullableString(row.ErrorReason), CancelledAt: nullableTimestampUTC(row.CancelledAt), DownloadExpiresAt: nullableTimestampUTC(row.DownloadExpiresAt)}
	if len(row.Manifest) > 0 {
		var manifest episodediagnostics.DiagnosticExportManifestV1
		if json.Unmarshal(row.Manifest, &manifest) == nil {
			job.Manifest = &manifest
		}
	}
	if row.TotalEvents.Valid || row.ProcessedEvents > 0 || row.CurrentCursor.Valid {
		progress := &episodediagnostics.ExportJobProgress{ProcessedEvents: row.ProcessedEvents, CurrentCursor: diagnosticCursorValue(row.CurrentCursor)}
		if row.TotalEvents.Valid {
			progress.TotalEvents = row.TotalEvents.Int64
			if row.TotalEvents.Int64 > 0 {
				progress.Percent = float64(row.ProcessedEvents) * 100 / float64(row.TotalEvents.Int64)
			}
		}
		job.Progress = progress
	}
	return job
}

func diagnosticCursorValue(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}
