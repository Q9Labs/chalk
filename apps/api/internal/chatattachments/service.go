package chatattachments

import (
	"context"
	"encoding/base64"
	"fmt"
	"mime"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func NewService(repository Repository, objects ObjectStore) Service {
	return Service{
		repository: repository,
		objects:    objects,
		now:        time.Now,
		telemetry:  newRequestTelemetry(nil, time.Now),
	}
}

func (s Service) Initiate(
	ctx context.Context,
	input InitiateInput,
) (result UploadInstructions, resultErr error) {
	ctx, finish := s.startRequest(ctx, "initiate")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil {
		return UploadInstructions{}, objectstorage.ErrStoreUnavailable
	}
	request, err := validateInitiate(input)
	if err != nil {
		return UploadInstructions{}, err
	}
	attachmentID, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate chat attachment id: %w", err)
	}
	uploadID, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate chat attachment upload id: %w", err)
	}

	now := s.now().UTC()
	expiresAt := now.Add(uploadLifetime)
	upload, err := s.repository.Reserve(ctx, ReserveInput{
		Subject: input.Subject, ClientAttachmentID: input.ClientAttachmentID,
		Upload: Upload{
			Attachment: Attachment{
				AttachmentID: attachmentID, FileName: request.fileName,
				MIMEType: request.mimeType, ByteLength: input.ByteLength,
			},
			UploadID: uploadID, ObjectKey: objectKey(input.Subject, uploadID),
			SHA256: request.digest, RequestFingerprint: request.fingerprint, Status: "pending",
			ExpiresAt: expiresAt,
		},
	})
	if err != nil {
		return UploadInstructions{}, err
	}
	if upload.Status != "pending" || !upload.ExpiresAt.After(now) {
		return UploadInstructions{}, ErrUploadExpired
	}

	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: upload.ObjectKey, ContentType: upload.MIMEType, ContentLength: upload.ByteLength,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(upload.SHA256[:]),
		ExpiresIn:      upload.ExpiresAt.Sub(now), IfNoneMatch: true,
		Metadata: map[string]string{
			"chalk-upload-id":     upload.UploadID.String(),
			"chalk-attachment-id": upload.AttachmentID.String(),
		},
	})
	if err != nil {
		s.failUpload(ctx, upload.UploadID, utilities.ID{})
		return UploadInstructions{}, fmt.Errorf("create chat attachment upload url: %w", err)
	}
	headers, err := signedHeaders(signed.SignedHeader)
	if err != nil {
		s.failUpload(ctx, upload.UploadID, utilities.ID{})
		return UploadInstructions{}, err
	}

	return UploadInstructions{
		AttachmentID: upload.AttachmentID, UploadID: upload.UploadID,
		Method: signed.Method, URL: signed.URL, Headers: headers, ExpiresAt: signed.ExpiresAt,
	}, nil
}

func (s Service) Finalize(
	ctx context.Context,
	subject Subject,
	uploadID utilities.ID,
) (result Attachment, resultErr error) {
	ctx, finish := s.startRequest(ctx, "finalize")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil || !subject.IsComplete() || uploadID.IsZero() {
		return Attachment{}, ErrInvalidInput
	}
	now := s.now().UTC()
	upload, err := s.repository.ClaimFinalize(
		ctx,
		subject,
		uploadID,
		now,
		now.Add(finalizeLeaseDuration),
	)
	if err != nil {
		return Attachment{}, err
	}
	if upload.Status == "ready" || upload.Status == "attached" {
		return upload.Attachment, nil
	}

	facts, err := s.objects.InspectObject(ctx, upload.ObjectKey)
	if err != nil {
		s.releaseFinalize(ctx, upload)
		return Attachment{}, fmt.Errorf("inspect chat attachment upload: %w", err)
	}
	if !upload.matches(facts) {
		return Attachment{}, s.rejectUpload(ctx, upload)
	}

	matches, err := s.objectDigestMatches(ctx, upload)
	if err != nil {
		s.releaseFinalize(ctx, upload)
		return Attachment{}, err
	}
	if !matches {
		return Attachment{}, s.rejectUpload(ctx, upload)
	}
	completedAt := s.now().UTC()
	if err := s.repository.Complete(ctx, CompleteInput{
		UploadID: uploadID, FinalizeClaimToken: upload.FinalizeClaimToken,
		ImmutableObjectIdentity: facts.ETag,
		ExpiresAt:               completedAt.Add(unattachedLifetime),
		Now:                     completedAt,
	}); err != nil {
		s.releaseFinalize(ctx, upload)
		return Attachment{}, err
	}
	return upload.Attachment, nil
}

func (s Service) Download(
	ctx context.Context,
	subject Subject,
	attachmentID utilities.ID,
) (result Download, resultErr error) {
	ctx, finish := s.startRequest(ctx, "download")
	defer func() { finish(resultErr) }()

	if s.repository == nil || s.objects == nil || !subject.IsComplete() || attachmentID.IsZero() {
		return Download{}, ErrInvalidInput
	}
	attachment, err := s.repository.AuthorizedDownload(ctx, subject, attachmentID)
	if err != nil {
		return Download{}, err
	}
	input := objectstorage.CreateDownloadURLInput{Key: attachment.ObjectKey, ExpiresIn: downloadLifetime}
	if !previewable(attachment.MIMEType) {
		input.ContentDisposition = mime.FormatMediaType("attachment", map[string]string{"filename": attachment.FileName})
	}
	signed, err := s.objects.CreateDownloadURL(ctx, input)
	if err != nil {
		return Download{}, fmt.Errorf("create chat attachment download url: %w", err)
	}
	return Download{URL: signed.URL, ExpiresAt: signed.ExpiresAt}, nil
}

func (s Service) startRequest(
	ctx context.Context,
	operation string,
) (context.Context, func(error)) {
	if s.telemetry == nil {
		return ctx, func(error) {}
	}
	return s.telemetry.start(ctx, operation)
}
