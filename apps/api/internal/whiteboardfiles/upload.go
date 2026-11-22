package whiteboardfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"golang.org/x/image/webp"
)

const (
	maxFileBytes       = 20 * 1024 * 1024
	uploadLifetime     = 5 * time.Minute
	unreferencedExpiry = 24 * time.Hour
)

var ErrFileConflict = errors.New("whiteboard file ID is already reserved for a different upload")

type FileRequest struct {
	Subject Subject
	SceneID utilities.ID
	FileID  string
}

type InitiateInput struct {
	FileRequest
	MIMEType   string
	ByteLength int64
	SHA256     string
}

type UploadInstructions struct {
	Ready     bool
	URL       string
	Headers   map[string]string
	ExpiresAt time.Time
}

func (s Service) Initiate(ctx context.Context, input InitiateInput) (UploadInstructions, error) {
	digest, err := parseDigest(input.SHA256)
	if err != nil || !input.valid() || !rasterImage(input.MIMEType) || input.ByteLength <= 0 || input.ByteLength > maxFileBytes {
		return UploadInstructions{}, ErrInvalidInput
	}
	id, err := utilities.NewID()
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("generate whiteboard upload ID: %w", err)
	}
	now := s.now().UTC()
	file, err := s.repository.Reserve(ctx, Upload{
		UploadID: id, Subject: input.Subject, SceneID: input.SceneID, FileID: input.FileID,
		ObjectKey: "whiteboard-v1/tenants/" + input.Subject.TenantID.String() + "/uploads/" + id.String(),
		MIMEType:  input.MIMEType, ByteLength: input.ByteLength, SHA256: digest, ExpiresAt: now.Add(uploadLifetime),
	})
	if err != nil {
		return UploadInstructions{}, err
	}
	if file.Status == "ready" {
		return UploadInstructions{Ready: true}, nil
	}
	// Sign against the original reservation deadline, not a refreshed lifetime.
	remaining := file.ExpiresAt.Sub(s.now().UTC().Truncate(time.Second).Add(time.Second))
	if remaining < time.Second {
		return UploadInstructions{}, ErrFileConflict
	}
	signed, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: file.ObjectKey, ContentType: input.MIMEType, ContentLength: input.ByteLength,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(digest[:]),
		ExpiresIn:      remaining, IfNoneMatch: true,
	})
	if err != nil {
		return UploadInstructions{}, fmt.Errorf("sign whiteboard upload: %w", err)
	}
	headers := make(map[string]string, len(signed.SignedHeader))
	for name, values := range signed.SignedHeader {
		if len(values) != 1 {
			return UploadInstructions{}, ErrFileTransferFailed
		}
		headers[name] = values[0]
	}
	return UploadInstructions{URL: signed.URL, Headers: headers, ExpiresAt: signed.ExpiresAt}, nil
}

func (s Service) Finalize(ctx context.Context, request FileRequest, sha256Hex string) error {
	digest, err := parseDigest(sha256Hex)
	if err != nil || !request.valid() {
		return ErrInvalidInput
	}
	file, err := s.repository.PendingOrReady(ctx, request)
	if err != nil {
		return err
	}
	if file.SHA256 != digest {
		return ErrFileConflict
	}
	if file.Status == "ready" {
		return nil
	}
	identity, err := s.verifyObject(ctx, file)
	if err != nil {
		return err
	}

	updated, err := s.repository.Finalize(ctx, request, file.UploadID, identity, s.now().UTC().Add(unreferencedExpiry))
	if err != nil || updated {
		return err
	}
	// A concurrent finalize may have committed while we verified the bytes.
	current, err := s.repository.PendingOrReady(ctx, request)
	if err != nil {
		return err
	}
	if current.Status == "ready" && current.SHA256 == digest {
		return nil
	}
	return ErrFileConflict
}

func (s Service) verifyObject(ctx context.Context, file Upload) (string, error) {
	// Bound concurrent allocations from raster decoders, not just the size of
	// each image. Already-ready retries never enter the decoder.
	select {
	case s.verifySlots <- struct{}{}:
		defer func() { <-s.verifySlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	object, err := s.objects.GetObject(ctx, file.ObjectKey)
	if err != nil {
		return "", fmt.Errorf("read whiteboard upload: %w", err)
	}
	defer object.Body.Close()
	if object.Size != file.ByteLength || object.ContentType != file.MIMEType || strings.TrimSpace(object.ETag) == "" {
		return "", ErrFileTransferFailed
	}
	body, err := io.ReadAll(io.LimitReader(object.Body, file.ByteLength+1))
	if err != nil {
		return "", fmt.Errorf("read whiteboard upload body: %w", err)
	}
	if int64(len(body)) != file.ByteLength || sha256.Sum256(body) != file.SHA256 {
		return "", ErrFileTransferFailed
	}
	if err := validateImage(body, file.MIMEType); err != nil {
		return "", err
	}
	return object.ETag, nil
}

func validateImage(body []byte, mimeType string) error {
	var config func(io.Reader) (image.Config, error)
	var decode func(io.Reader) (image.Image, error)
	switch mimeType {
	case "image/png":
		config, decode = png.DecodeConfig, png.Decode
	case "image/jpeg":
		config, decode = jpeg.DecodeConfig, jpeg.Decode
	case "image/gif":
		config, decode = gif.DecodeConfig, gif.Decode
	case "image/webp":
		config, decode = webp.DecodeConfig, webp.Decode
	default:
		return ErrFileTransferFailed
	}
	dimensions, err := config(bytes.NewReader(body))
	if err != nil || !boundedImageDimensions(dimensions.Width, dimensions.Height) {
		return ErrFileTransferFailed
	}
	if mimeType == "image/webp" {
		// The raster decoder reads still pictures, so validate an animation's
		// first displayable frame as a still WebP without altering the upload.
		body, err = firstWebPFrame(body, dimensions)
		if err != nil {
			return err
		}
	}
	if _, err := decode(bytes.NewReader(body)); err != nil {
		return ErrFileTransferFailed
	}
	return nil
}

func boundedImageDimensions(width, height int) bool {
	const maxDimension, maxPixels = 16_384, 16_777_216
	return width > 0 && height > 0 && width <= maxDimension && height <= maxDimension && width*height <= maxPixels
}

func (r FileRequest) valid() bool {
	return r.Subject.IsComplete() && !r.SceneID.IsZero() && validFileID(r.FileID)
}

func parseDigest(value string) ([32]byte, error) {
	var digest [32]byte
	if len(value) != hex.EncodedLen(len(digest)) {
		return digest, ErrInvalidInput
	}
	_, err := hex.Decode(digest[:], []byte(value))
	return digest, err
}

func rasterImage(mimeType string) bool {
	switch mimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}
