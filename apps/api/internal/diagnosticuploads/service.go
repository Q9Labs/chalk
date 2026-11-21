// Package diagnosticuploads issues presigned PUTs for one gzip diagnostic
// bundle per stored problem report or live introspection request, then commits
// the row's state when the client completes. Every state change is a kernel
// transition on the report.upload_state machine; issue and complete are
// decisions. Tokens, and bundle bytes, never reach a log.
package diagnosticuploads

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidInput   = errors.New("invalid diagnostic upload request")
	ErrTargetMissing  = errors.New("diagnostic upload target not found")
	ErrUploadMissing  = errors.New("diagnostic upload not found")
	ErrUploadExists   = errors.New("diagnostic upload already issued")
	ErrRequestExpired = errors.New("diagnostic upload request expired")
	ErrSizeMismatch   = errors.New("diagnostic upload size mismatch")
	ErrObjectMissing  = errors.New("diagnostic upload object missing")
	ErrNotIssued      = errors.New("diagnostic upload is not issued")
	ErrStorage        = errors.New("diagnostic upload storage unavailable")
)

// IssueLifetime is the fixed presigned-PUT window the spec fixes at 120 s.
const IssueLifetime = 120 * time.Second

const (
	TriggerReport = "report"
	TriggerLive   = "live"

	contentType = "application/gzip"
)

// Upload is the diagnostic_uploads row.
type Upload struct {
	ID            utilities.ID
	TenantID      utilities.ID
	EpisodeID     utilities.ID
	ReportID      utilities.ID
	LiveRequestID utilities.ID
	Trigger       string
	State         string
	ObjectKey     string
	Bytes         *int64
	SHA256        string
	IssuedAt      time.Time
	StoredAt      *time.Time
	FailedAt      *time.Time
	ExpiresAt     time.Time
}

// ReportTarget and LiveTarget are what an upload's key and expiry need from
// the row it answers.
type ReportTarget struct {
	ID            utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}
type LiveTarget struct {
	ID            utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	ExpiresAt     time.Time
}

type Repository interface {
	ReportTarget(context.Context, utilities.ID, utilities.ID) (ReportTarget, error)
	LiveTarget(context.Context, utilities.ID, utilities.ID) (LiveTarget, error)
	InsertIssued(context.Context, Upload) (Upload, error)
	Get(context.Context, utilities.ID, utilities.ID) (Upload, error)
	MarkStored(context.Context, utilities.ID, utilities.ID, int64, string) error
	MarkFailed(context.Context, utilities.ID, utilities.ID) error
	MarkExpired(context.Context, utilities.ID, utilities.ID) error
}

// Objects is the object storage the service presigns and inspects through.
type Objects interface {
	CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error)
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
}

type Service struct {
	repository Repository
	objects    Objects
}

func NewService(repository Repository, objects Objects) Service {
	return Service{repository: repository, objects: objects}
}

func (s Service) Available() bool { return s.repository != nil && s.objects != nil }

type IssueInput struct {
	Trigger       string
	ReportID      utilities.ID
	LiveRequestID utilities.ID
}

type Issued struct {
	UploadID  utilities.ID
	URL       string
	Method    string
	Headers   map[string][]string
	ExpiresAt time.Time
}

// Issue writes the issued row beside the presigned PUT and records the
// "report.upload.issue" decision once it commits.
func (s Service) Issue(ctx context.Context, subject accessgrants.Subject, input IssueInput) (Issued, error) {
	uploadID, err := utilities.NewID()
	if err != nil {
		return Issued{}, err
	}
	expiresAt := time.Now().Add(IssueLifetime)
	refuse := func(reason string) { s.refuseIssue(ctx, uploadID, input, expiresAt, reason) }
	if !s.Available() {
		refuse(obs.ReasonReportUploadRefused)
		return Issued{}, ErrStorage
	}
	var episodeID utilities.ID
	switch input.Trigger {
	case TriggerReport:
		target, err := s.repository.ReportTarget(ctx, subject.TenantID, input.ReportID)
		switch {
		case errors.Is(err, ErrTargetMissing):
			refuse(obs.ReasonReportUploadRefused)
			return Issued{}, ErrTargetMissing
		case err != nil:
			refuse(obs.ReasonReportUploadRefused)
			return Issued{}, err
		}
		episodeID = target.EpisodeID
	case TriggerLive:
		target, err := s.repository.LiveTarget(ctx, subject.TenantID, input.LiveRequestID)
		switch {
		case errors.Is(err, ErrTargetMissing):
			refuse(obs.ReasonReportUploadRefused)
			return Issued{}, ErrTargetMissing
		case err != nil:
			refuse(obs.ReasonReportUploadRefused)
			return Issued{}, err
		}
		if !target.ExpiresAt.After(time.Now()) {
			refuse(obs.ReasonReportUploadExpired)
			return Issued{}, ErrRequestExpired
		}
		episodeID = target.EpisodeID
	default:
		// A malformed trigger never produced a decision to record.
		return Issued{}, ErrInvalidInput
	}
	if input.ReportID.IsZero() == input.LiveRequestID.IsZero() {
		return Issued{}, ErrInvalidInput
	}
	if episodeID.IsZero() {
		episodeID = subject.EpisodeID
	}
	key := fmt.Sprintf("diagnostics/%s/%s/%s.json.gz", subject.TenantID, episodeID, uploadID)
	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key:         key,
		ContentType: contentType,
		ExpiresIn:   IssueLifetime,
	})
	if err != nil {
		refuse(obs.ReasonReportUploadRefused)
		return Issued{}, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	if !signed.ExpiresAt.IsZero() {
		expiresAt = signed.ExpiresAt
	}
	upload, err := s.repository.InsertIssued(ctx, Upload{
		ID:            uploadID,
		TenantID:      subject.TenantID,
		EpisodeID:     episodeID,
		ReportID:      input.ReportID,
		LiveRequestID: input.LiveRequestID,
		Trigger:       input.Trigger,
		State:         "issued",
		ObjectKey:     key,
		ExpiresAt:     expiresAt,
	})
	switch {
	case errors.Is(err, ErrUploadExists):
		refuse(obs.ReasonReportUploadRefused)
		return Issued{}, ErrUploadExists
	case err != nil:
		refuse(obs.ReasonReportUploadRefused)
		return Issued{}, err
	}
	obs.Decision(ctx, "report.upload.issue", "issued", "", issueAttrs(uploadID, input, upload.ExpiresAt)...)
	return Issued{UploadID: uploadID, URL: signed.URL, Method: signed.Method, Headers: signed.SignedHeader, ExpiresAt: upload.ExpiresAt}, nil
}

type CompleteInput struct {
	Bytes  int64
	SHA256 string
}

type Completed struct {
	UploadID utilities.ID
	State    string
}

// Complete inspects the stored object and commits stored only when the size the
// client reported matches the object R2 holds. Every refusal still writes the
// machine's terminal state and the "report.upload.complete" decision.
func (s Service) Complete(ctx context.Context, subject accessgrants.Subject, uploadID utilities.ID, input CompleteInput) (Completed, error) {
	refuse := func(reason string) {
		if !uploadID.IsZero() {
			obs.Decision(ctx, "report.upload.complete", "refused", reason, obs.F("diagnostic_upload_id", uploadID.String()))
		}
	}
	if !s.Available() {
		refuse(obs.ReasonReportUploadRefused)
		return Completed{}, ErrStorage
	}
	upload, err := s.repository.Get(ctx, subject.TenantID, uploadID)
	switch {
	case errors.Is(err, ErrUploadMissing):
		refuse(obs.ReasonReportUploadMissing)
		return Completed{}, ErrUploadMissing
	case err != nil:
		refuse(obs.ReasonReportUploadRefused)
		return Completed{}, err
	}
	if upload.State != "issued" {
		refuse(obs.ReasonReportUploadRefused)
		return Completed{}, ErrNotIssued
	}
	if !upload.ExpiresAt.After(time.Now()) {
		if err := s.repository.MarkExpired(ctx, subject.TenantID, uploadID); err == nil {
			transition(ctx, "expired", "request_expired")
		}
		refuse(obs.ReasonReportUploadExpired)
		return Completed{}, ErrRequestExpired
	}
	facts, err := s.objects.InspectObject(ctx, upload.ObjectKey)
	switch {
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		if failErr := s.repository.MarkFailed(ctx, subject.TenantID, uploadID); failErr == nil {
			transition(ctx, "failed", "object_missing")
		}
		refuse(obs.ReasonReportUploadMissing)
		return Completed{}, ErrObjectMissing
	case err != nil:
		refuse(obs.ReasonReportUploadRefused)
		return Completed{}, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	if facts.Size != input.Bytes {
		if failErr := s.repository.MarkFailed(ctx, subject.TenantID, uploadID); failErr == nil {
			transition(ctx, "failed", "size_mismatch")
		}
		refuse(obs.ReasonReportUploadMismatch)
		return Completed{}, ErrSizeMismatch
	}
	if err := s.repository.MarkStored(ctx, subject.TenantID, uploadID, input.Bytes, input.SHA256); err != nil {
		refuse(obs.ReasonReportUploadRefused)
		return Completed{}, err
	}
	transition(ctx, "stored", "complete")
	attrs := []slog.Attr{obs.F("diagnostic_upload_id", uploadID.String()), obs.F("bytes", input.Bytes)}
	if input.SHA256 != "" {
		attrs = append(attrs, obs.F("sha256", input.SHA256))
	}
	obs.Decision(ctx, "report.upload.complete", "stored", "", attrs...)
	return Completed{UploadID: uploadID, State: "stored"}, nil
}

func issueAttrs(uploadID utilities.ID, input IssueInput, expiresAt time.Time) []slog.Attr {
	attrs := []slog.Attr{
		obs.F("diagnostic_upload_id", uploadID.String()),
		obs.F("upload_trigger", input.Trigger),
		obs.F("expires_ms", expiresAt.UnixMilli()),
	}
	if !input.ReportID.IsZero() {
		attrs = append(attrs, obs.F("report_id", input.ReportID.String()))
	}
	if !input.LiveRequestID.IsZero() {
		attrs = append(attrs, obs.F("live_request_id", input.LiveRequestID.String()))
	}
	return attrs
}

func (s Service) refuseIssue(ctx context.Context, uploadID utilities.ID, input IssueInput, expiresAt time.Time, reason string) {
	if uploadID.IsZero() {
		return
	}
	obs.Decision(ctx, "report.upload.issue", "refused", reason, issueAttrs(uploadID, input, expiresAt)...)
}

// transition records one report.upload_state edge. Machine attrs carry only the
// request's trail, so the upload id stays on the row and the decision.
func transition(ctx context.Context, to string, trigger string) {
	obs.Transition(ctx, obs.Move{Machine: "report.upload_state", From: "issued", To: to, Trigger: trigger})
}
