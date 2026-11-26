package presenting

import (
	"context"
	"fmt"
	"sync"
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
	if !capabilityMatchesJob(capability, claimed.Job) {
		return ControlAssignment{}, false, ErrLeaseLost
	}
	leaseExpiry, ttl := claimedLease(claimed.Job, now)
	if ttl <= 0 {
		return ControlAssignment{}, false, ErrNoRenderJob
	}
	if err := s.repository.TrackRenderUploads(ctx, renderUploads(claimed)); err != nil {
		return ControlAssignment{}, false, err
	}
	source, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: claimed.Document.SourceKey, ExpiresIn: ttl})
	if err != nil {
		return ControlAssignment{}, false, fmt.Errorf("sign presenting source: %w", err)
	}
	uploads, err := s.signPageUploads(ctx, claimed, ttl)
	if err != nil {
		return ControlAssignment{}, false, err
	}
	assignment := ControlAssignment{
		JobID: claimed.Job.JobID.String(), TenantID: claimed.Job.TenantID.String(), SpaceID: claimed.Job.SpaceID.String(), DocumentID: claimed.Document.DocumentID.String(), Kind: claimed.Job.Kind,
		PageStart: claimed.Job.PageStart, PageEnd: claimed.Job.PageEnd, Attempt: claimed.Job.Attempt,
		LeaseToken: token.String(), LeaseExpiresAt: leaseExpiry.UTC().Format(time.RFC3339Nano),
		FileName: claimed.Document.FileName, MIMEType: claimed.Document.MIMEType,
		SourceURL: source.URL, SourceExpiresAt: source.ExpiresAt.UTC().Format(time.RFC3339Nano),
		SourceSHA256: fmt.Sprintf("%x", claimed.Document.SourceSHA256), SourceSizeBytes: claimed.Document.ByteLength,
		Uploads: uploads,
	}
	return assignment, true, nil
}

func capabilityMatchesJob(capability RenderCapability, job RenderJob) bool {
	return job.TenantID == capability.TenantID && job.SpaceID == capability.SpaceID && job.DocumentID == capability.DocumentID && job.Kind == capability.Kind && job.PageStart == capability.PageStart && job.PageEnd == capability.PageEnd && job.Attempt == capability.Attempt
}

// claimedLease returns the lease expiry and the time left on it. A claim without an expiry gets the default lease.
func claimedLease(job RenderJob, now time.Time) (time.Time, time.Duration) {
	leaseExpiry := job.LeaseExpiry
	if leaseExpiry.IsZero() {
		leaseExpiry = now.Add(RenderLeaseDuration)
	}
	return leaseExpiry, time.Until(leaseExpiry)
}

// renderUploads lists the objects the renderer may write for each page of the claimed job.
func renderUploads(claimed RenderAssignment) []RenderUpload {
	job, document := claimed.Job, claimed.Document
	tracked := make([]RenderUpload, 0, (job.PageEnd-job.PageStart+1)*2)
	for page := job.PageStart; page <= job.PageEnd; page++ {
		base := RenderUpload{TenantID: job.TenantID, SpaceID: job.SpaceID, DocumentID: job.DocumentID, JobID: job.JobID, Page: page, Attempt: job.Attempt}
		if job.Kind == "zoom" {
			base.Rendition = "zoom"
			base.ObjectKey = attemptZoomKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page)
			tracked = append(tracked, base)
			continue
		}
		base.Rendition = "image"
		base.ObjectKey = attemptImageKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page)
		tracked = append(tracked, base)
		base.Rendition = "thumbnail"
		base.ObjectKey = attemptThumbnailKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page)
		tracked = append(tracked, base)
	}
	return tracked
}

func (s Service) signPageUploads(ctx context.Context, claimed RenderAssignment, ttl time.Duration) ([]PageUploads, error) {
	var uploads []PageUploads
	for page := claimed.Job.PageStart; page <= claimed.Job.PageEnd; page++ {
		upload, err := s.signRenderPage(ctx, claimed, page, ttl)
		if err != nil {
			return nil, err
		}
		uploads = append(uploads, upload)
	}
	return uploads, nil
}

func (s Service) signRenderPage(ctx context.Context, claimed RenderAssignment, page int, ttl time.Duration) (PageUploads, error) {
	job, document := claimed.Job, claimed.Document
	upload := PageUploads{Page: page}
	var err error
	if job.Kind == "zoom" {
		upload.Zoom, err = s.signUpload(ctx, attemptZoomKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page), ttl)
		return upload, err
	}
	upload.Image, err = s.signUpload(ctx, attemptImageKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page), ttl)
	if err != nil {
		return upload, err
	}
	upload.Thumbnail, err = s.signUpload(ctx, attemptThumbnailKey(document.TenantID, document.SpaceID, document.EpisodeID, document.DocumentID, job.JobID, job.Attempt, page), ttl)
	return upload, err
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
	var wait sync.WaitGroup
	for _, job := range jobs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_ = s.invokeJob(ctx, job, false)
		}()
	}
	wait.Wait()
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
