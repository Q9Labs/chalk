package whiteboardfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
	object, err := s.objects.GetObject(ctx, file.ObjectKey)
	if err != nil {
		return "", fmt.Errorf("read whiteboard upload: %w", err)
	}
	defer object.Body.Close()
	if object.Size != file.ByteLength || object.ContentType != file.MIMEType || strings.TrimSpace(object.ETag) == "" {
		return "", ErrFileTransferFailed
	}
	stream := &io.LimitedReader{R: object.Body, N: file.ByteLength + 1}
	hash := sha256.New()
	body := io.TeeReader(stream, hash)
	if err := validateImageDimensions(body, file.MIMEType); err != nil {
		return "", err
	}
	if _, err := io.Copy(io.Discard, body); err != nil {
		return "", fmt.Errorf("hash whiteboard upload: %w", err)
	}
	if stream.N != 1 || !bytes.Equal(hash.Sum(nil), file.SHA256[:]) {
		return "", ErrFileTransferFailed
	}
	return object.ETag, nil
}

func validateImageDimensions(body io.Reader, mimeType string) error {
	var dimensions image.Config
	var err error
	switch mimeType {
	case "image/png":
		dimensions, err = png.DecodeConfig(body)
	case "image/jpeg":
		dimensions, err = jpeg.DecodeConfig(body)
	case "image/gif":
		dimensions, err = gif.DecodeConfig(body)
	case "image/webp":
		dimensions, err = webpConfig(body)
	default:
		return ErrFileTransferFailed
	}
	const maxDimension, maxPixels = 16_384, 16_777_216
	if err != nil || dimensions.Width <= 0 || dimensions.Height <= 0 ||
		dimensions.Width > maxDimension || dimensions.Height > maxDimension ||
		dimensions.Width*dimensions.Height > maxPixels {
		return ErrFileTransferFailed
	}
	return nil
}

func webpConfig(body io.Reader) (image.Config, error) {
	var header [30]byte
	n, err := io.ReadFull(body, header[:])
	// VP8L headers are five bytes rather than ten.
	if (err != nil && !errors.Is(err, io.ErrUnexpectedEOF)) || n < 25 || http.DetectContentType(header[:n]) != "image/webp" {
		return image.Config{}, ErrFileTransferFailed
	}
	switch string(header[12:16]) {
	case "VP8X":
		if n == len(header) {
			return image.Config{
				Width:  1 + int(binary.LittleEndian.Uint32(header[23:27])>>8),
				Height: 1 + int(binary.LittleEndian.Uint32(header[26:30])>>8),
			}, nil
		}
	case "VP8L":
		if header[20] == 0x2f {
			bits := binary.LittleEndian.Uint32(header[21:25])
			return image.Config{Width: 1 + int(bits&0x3fff), Height: 1 + int((bits>>14)&0x3fff)}, nil
		}
	case "VP8 ":
		if n == len(header) && bytes.Equal(header[23:26], []byte{0x9d, 0x01, 0x2a}) {
			return image.Config{
				Width:  int(binary.LittleEndian.Uint16(header[26:28]) & 0x3fff),
				Height: int(binary.LittleEndian.Uint16(header[28:30]) & 0x3fff),
			}, nil
		}
	}
	return image.Config{}, ErrFileTransferFailed
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
