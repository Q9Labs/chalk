package chatattachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) objectDigestMatches(ctx context.Context, upload Upload) (bool, error) {
	object, err := s.objects.GetObject(ctx, upload.ObjectKey)
	if err != nil {
		return false, fmt.Errorf("read chat attachment upload: %w", err)
	}
	defer object.Body.Close()

	digest := sha256.New()
	read, err := io.CopyN(digest, object.Body, upload.ByteLength+1)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, fmt.Errorf("hash chat attachment upload: %w", err)
	}
	if read != upload.ByteLength {
		return false, nil
	}
	return bytes.Equal(digest.Sum(nil), upload.SHA256[:]), nil
}

func (s Service) rejectUpload(ctx context.Context, upload Upload) error {
	_ = s.objects.DeleteObject(ctx, upload.ObjectKey)
	s.failUpload(ctx, upload.UploadID, upload.FinalizeClaimToken)
	return ErrFileTransferFailed
}

// failUpload marks a pending upload failed. The caller already returns the
// original error, so a failed mark is logged with the upload id and not returned.
func (s Service) failUpload(ctx context.Context, uploadID, claimToken utilities.ID) {
	err := s.repository.Fail(ctx, uploadID, claimToken)
	if err == nil {
		return
	}
	logger := slog.Default()
	if s.telemetry != nil {
		logger = s.telemetry.logger
	}
	logger.ErrorContext(ctx, "chat attachment upload could not be marked failed",
		"event", "chat_attachment.fail_mark_failed", "upload_id", uploadID.String(), "error", err)
}

func (s Service) releaseFinalize(ctx context.Context, upload Upload) {
	releaseContext, cancel := context.WithTimeout(
		context.WithoutCancel(ctx),
		finalizeMutationTimeout,
	)
	defer cancel()
	_ = s.repository.ReleaseFinalize(
		releaseContext,
		upload.UploadID,
		upload.FinalizeClaimToken,
	)
}

// matches reports whether the stored object is the one this upload reserved.
func (u Upload) matches(facts objectstorage.ObjectFacts) bool {
	return facts.Size == u.ByteLength &&
		strings.EqualFold(facts.ContentType, u.MIMEType) &&
		facts.Metadata["chalk-upload-id"] == u.UploadID.String() &&
		facts.Metadata["chalk-attachment-id"] == u.AttachmentID.String() &&
		strings.TrimSpace(facts.ETag) != ""
}
