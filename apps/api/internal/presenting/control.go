package presenting

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SignedUpload struct {
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expiresAt"`
}

type PageUploads struct {
	Page      int          `json:"page"`
	Image     SignedUpload `json:"image"`
	Thumbnail SignedUpload `json:"thumbnail,omitempty"`
	Zoom      SignedUpload `json:"zoom,omitempty"`
}

type ControlAssignment struct {
	JobID           string        `json:"jobId"`
	TenantID        string        `json:"tenantId"`
	SpaceID         string        `json:"spaceId"`
	DocumentID      string        `json:"documentId"`
	Kind            string        `json:"kind"`
	PageStart       int           `json:"pageStart"`
	PageEnd         int           `json:"pageEnd"`
	Attempt         int           `json:"attempt"`
	LeaseToken      string        `json:"leaseToken"`
	LeaseExpiresAt  string        `json:"leaseExpiresAt"`
	FileName        string        `json:"fileName"`
	MIMEType        string        `json:"mimeType"`
	SourceURL       string        `json:"sourceUrl"`
	SourceExpiresAt string        `json:"sourceExpiresAt"`
	SourceSHA256    string        `json:"sourceSha256"`
	SourceSizeBytes int64         `json:"sourceSizeBytes"`
	Uploads         []PageUploads `json:"uploads"`
}

func (s Service) ClaimRender(ctx context.Context, capability RenderCapability) (ControlAssignment, bool, error) {
	if s.repository == nil || s.objects == nil || !s.isAvailable(ctx) {
		return ControlAssignment{}, false, ErrRenderUnavailable
	}
	now := s.now().UTC()
	token, err := utilities.NewID()
	if err != nil {
		return ControlAssignment{}, false, fmt.Errorf("generate presenting render lease: %w", err)
	}
	claimed, err := s.repository.ClaimRenderJob(ctx, capability.JobID, capability.Attempt, now, now.Add(RenderLeaseDuration), token, "document-renderer")
	if err != nil {
		return ControlAssignment{}, false, err
	}
	if !claimedJobMatchesCapability(claimed.Job, capability) {
		return ControlAssignment{}, false, ErrLeaseLost
	}
	leaseExpiry := claimed.Job.LeaseExpiry
	if leaseExpiry.IsZero() {
		leaseExpiry = now.Add(RenderLeaseDuration)
	}
	ttl := time.Until(leaseExpiry)
	if ttl <= 0 {
		return ControlAssignment{}, false, ErrNoRenderJob
	}
	tracked := renderUploadsForClaim(claimed)
	if err := s.repository.TrackRenderUploads(ctx, tracked); err != nil {
		return ControlAssignment{}, false, err
	}
	source, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: claimed.Document.SourceKey, ExpiresIn: ttl})
	if err != nil {
		return ControlAssignment{}, false, fmt.Errorf("sign presenting source: %w", err)
	}
	assignment := ControlAssignment{
		JobID: claimed.Job.JobID.String(), TenantID: claimed.Job.TenantID.String(), SpaceID: claimed.Job.SpaceID.String(), DocumentID: claimed.Document.DocumentID.String(), Kind: claimed.Job.Kind,
		PageStart: claimed.Job.PageStart, PageEnd: claimed.Job.PageEnd, Attempt: claimed.Job.Attempt,
		LeaseToken: token.String(), LeaseExpiresAt: leaseExpiry.UTC().Format(time.RFC3339Nano),
		FileName: claimed.Document.FileName, MIMEType: claimed.Document.MIMEType,
		SourceURL: source.URL, SourceExpiresAt: source.ExpiresAt.UTC().Format(time.RFC3339Nano),
		SourceSHA256: fmt.Sprintf("%x", claimed.Document.SourceSHA256), SourceSizeBytes: claimed.Document.ByteLength,
	}
	uploads, err := s.signRenderUploads(ctx, claimed, ttl)
	if err != nil {
		return ControlAssignment{}, false, err
	}
	assignment.Uploads = uploads
	return assignment, true, nil
}

func claimedJobMatchesCapability(job RenderJob, capability RenderCapability) bool {
	return job.TenantID == capability.TenantID && job.SpaceID == capability.SpaceID && job.DocumentID == capability.DocumentID && job.Kind == capability.Kind && job.PageStart == capability.PageStart && job.PageEnd == capability.PageEnd && job.Attempt == capability.Attempt
}

func renderUploadsForClaim(claimed RenderAssignment) []RenderUpload {
	tracked := make([]RenderUpload, 0, (claimed.Job.PageEnd-claimed.Job.PageStart+1)*2)
	for page := claimed.Job.PageStart; page <= claimed.Job.PageEnd; page++ {
		base := RenderUpload{TenantID: claimed.Job.TenantID, SpaceID: claimed.Job.SpaceID, DocumentID: claimed.Job.DocumentID, JobID: claimed.Job.JobID, Page: page, Attempt: claimed.Job.Attempt}
		if claimed.Job.Kind == "zoom" {
			base.Rendition = "zoom"
			base.ObjectKey = attemptZoomKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page)
			tracked = append(tracked, base)
			continue
		}
		base.Rendition = "image"
		base.ObjectKey = attemptImageKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page)
		tracked = append(tracked, base)
		base.Rendition = "thumbnail"
		base.ObjectKey = attemptThumbnailKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page)
		tracked = append(tracked, base)
	}
	return tracked
}

func (s Service) signRenderUploads(ctx context.Context, claimed RenderAssignment, ttl time.Duration) ([]PageUploads, error) {
	uploads := make([]PageUploads, 0, claimed.Job.PageEnd-claimed.Job.PageStart+1)
	for page := claimed.Job.PageStart; page <= claimed.Job.PageEnd; page++ {
		upload, err := s.signPageUploads(ctx, claimed, page, ttl)
		if err != nil {
			return nil, err
		}
		uploads = append(uploads, upload)
	}
	return uploads, nil
}

func (s Service) signPageUploads(ctx context.Context, claimed RenderAssignment, page int, ttl time.Duration) (PageUploads, error) {
	upload := PageUploads{Page: page}
	var err error
	if claimed.Job.Kind == "zoom" {
		upload.Zoom, err = s.signUpload(ctx, attemptZoomKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page), ttl)
	} else {
		upload.Image, err = s.signUpload(ctx, attemptImageKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page), ttl)
		if err == nil {
			upload.Thumbnail, err = s.signUpload(ctx, attemptThumbnailKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, claimed.Job.JobID, claimed.Job.Attempt, page), ttl)
		}
	}
	if err != nil {
		return PageUploads{}, err
	}
	return upload, nil
}

func (s Service) signUpload(ctx context.Context, key string, ttl time.Duration) (SignedUpload, error) {
	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{Key: key, ContentType: renderJobContentType, ExpiresIn: ttl})
	if err != nil {
		return SignedUpload{}, fmt.Errorf("sign presenting page upload: %w", err)
	}
	headers := make(map[string]string, len(signed.SignedHeader))
	for name, values := range signed.SignedHeader {
		if len(values) == 1 {
			headers[name] = values[0]
		}
	}
	return SignedUpload{URL: signed.URL, Headers: headers, ExpiresAt: signed.ExpiresAt.UTC().Format(time.RFC3339Nano)}, nil
}

func (s Service) HeartbeatRender(ctx context.Context, lease RenderLease) error {
	return s.repository.HeartbeatRenderJob(ctx, lease, s.now().UTC().Add(RenderLeaseDuration))
}

func (s Service) ReconcileRenderJobs(ctx context.Context, limit int) (int, int, error) {
	if s.repository == nil || s.invoker == nil || !s.isAvailable(ctx) {
		return 0, 0, ErrRenderUnavailable
	}
	jobs, err := s.repository.ListStaleRenderJobs(ctx, s.now().UTC(), limit)
	if err != nil {
		return 0, 0, err
	}
	invoked := 0
	var first error
	for _, job := range jobs {
		if err := s.invokeJob(ctx, job, false); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		invoked++
	}
	return len(jobs), invoked, first
}

func (s Service) CompleteInventory(ctx context.Context, report InventoryReport) error {
	jobs, err := s.repository.CompleteInventory(ctx, report, RenderJobPageRange)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		_ = s.invokeJob(ctx, job, false)
	}
	return nil
}

func (s Service) MarkPageReady(ctx context.Context, lease RenderLease, page int) error {
	return s.repository.MarkPageReady(ctx, lease, page)
}

func (s Service) CompleteRender(ctx context.Context, lease RenderLease) error {
	return s.repository.CompleteRenderJob(ctx, lease)
}

func (s Service) FailRender(ctx context.Context, lease RenderLease, failure RenderFailure) error {
	return s.repository.FailRenderJob(ctx, lease, failure)
}

func (s Service) CompleteZoomRender(ctx context.Context, lease RenderLease) error {
	return s.repository.CompleteZoom(ctx, lease)
}
