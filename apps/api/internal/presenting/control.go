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

func (s Service) ClaimRender(ctx context.Context, jobID utilities.ID) (ControlAssignment, bool, error) {
	if s.repository == nil || s.objects == nil {
		return ControlAssignment{}, false, ErrRenderUnavailable
	}
	now := s.now().UTC()
	token, err := utilities.NewID()
	if err != nil {
		return ControlAssignment{}, false, fmt.Errorf("generate presenting render lease: %w", err)
	}
	claimed, err := s.repository.ClaimRenderJob(ctx, jobID, now, now.Add(RenderLeaseDuration), token, "document-renderer")
	if err != nil {
		return ControlAssignment{}, false, err
	}
	leaseExpiry := claimed.Job.LeaseExpiry
	if leaseExpiry.IsZero() {
		leaseExpiry = now.Add(RenderLeaseDuration)
	}
	ttl := time.Until(leaseExpiry)
	if ttl <= 0 {
		return ControlAssignment{}, false, ErrNoRenderJob
	}
	source, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: claimed.Document.SourceKey, ExpiresIn: ttl})
	if err != nil {
		return ControlAssignment{}, false, fmt.Errorf("sign presenting source: %w", err)
	}
	assignment := ControlAssignment{
		JobID: claimed.Job.JobID.String(), DocumentID: claimed.Document.DocumentID.String(), Kind: claimed.Job.Kind,
		PageStart: claimed.Job.PageStart, PageEnd: claimed.Job.PageEnd, Attempt: claimed.Job.Attempt,
		LeaseToken: token.String(), LeaseExpiresAt: leaseExpiry.UTC().Format(time.RFC3339Nano),
		FileName: claimed.Document.FileName, MIMEType: claimed.Document.MIMEType,
		SourceURL: source.URL, SourceExpiresAt: source.ExpiresAt.UTC().Format(time.RFC3339Nano),
		SourceSHA256: fmt.Sprintf("%x", claimed.Document.SourceSHA256), SourceSizeBytes: claimed.Document.ByteLength,
	}
	pages := make([]int, 0, claimed.Job.PageEnd-claimed.Job.PageStart+1)
	for page := claimed.Job.PageStart; page <= claimed.Job.PageEnd; page++ {
		pages = append(pages, page)
	}
	for _, page := range pages {
		upload := PageUploads{Page: page}
		if claimed.Job.Kind == "zoom" {
			upload.Zoom, err = s.signUpload(ctx, zoomKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, page), ttl)
		} else {
			upload.Image, err = s.signUpload(ctx, imageKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, page), ttl)
			if err == nil {
				upload.Thumbnail, err = s.signUpload(ctx, thumbnailKey(claimed.Document.TenantID, claimed.Document.SpaceID, claimed.Document.EpisodeID, claimed.Document.DocumentID, page), ttl)
			}
		}
		if err != nil {
			return ControlAssignment{}, false, err
		}
		assignment.Uploads = append(assignment.Uploads, upload)
	}
	return assignment, true, nil
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

func (s Service) CompleteInventory(ctx context.Context, report InventoryReport) error {
	jobs, err := s.repository.CompleteInventory(ctx, report, RenderJobPageRange)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		s.invoke(ctx, InvokeInput{JobID: job.JobID})
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
