package chatattachments

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"mime"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var allowedMIMETypes = map[string]struct{}{
	"image/png":          {},
	"image/jpeg":         {},
	"image/gif":          {},
	"image/webp":         {},
	"application/pdf":    {},
	"text/plain":         {},
	"application/msword": {},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": {},
	"application/vnd.ms-excel": {},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {},
	"application/vnd.ms-powerpoint":                                             {},
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {},
	"application/vnd.oasis.opendocument.text":                                   {},
	"application/vnd.oasis.opendocument.spreadsheet":                            {},
	"application/vnd.oasis.opendocument.presentation":                           {},
}

// initiateRequest holds the validated, normalized form of an InitiateInput.
type initiateRequest struct {
	fileName    string
	mimeType    string
	digest      [32]byte
	fingerprint [32]byte
}

func validateInitiate(input InitiateInput) (initiateRequest, error) {
	if !input.Subject.IsComplete() ||
		len(input.ClientAttachmentID) < minClientAttachmentIDBytes ||
		len(input.ClientAttachmentID) > maxClientAttachmentIDBytes ||
		input.ByteLength <= 0 ||
		input.ByteLength > maxFileBytes {
		return initiateRequest{}, ErrInvalidInput
	}
	fileName, ok := validFileName(input.FileName)
	mimeType, allowed := allowedMIMEType(input.MIMEType)
	decoded, hexErr := hex.DecodeString(input.SHA256)
	if !ok || !allowed || hexErr != nil || len(decoded) != sha256.Size || input.SHA256 != strings.ToLower(input.SHA256) {
		return initiateRequest{}, ErrInvalidInput
	}
	request := initiateRequest{fileName: fileName, mimeType: mimeType}
	copy(request.digest[:], decoded)
	request.fingerprint = sha256.Sum256([]byte(fmt.Sprintf(
		"chat-attachment-v1\x00%s\x00%s\x00%d\x00%s",
		fileName, mimeType, input.ByteLength, input.SHA256,
	)))
	return request, nil
}

func allowedMIMEType(value string) (string, bool) {
	mimeType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil {
		return "", false
	}
	mimeType = strings.ToLower(mimeType)
	_, ok := allowedMIMETypes[mimeType]
	return mimeType, ok
}

func validFileName(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." || value == ".." || !utf8.ValidString(value) ||
		len(value) > maxFileNameBytes || strings.ContainsAny(value, `/\`) {
		return "", false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", false
		}
	}
	return value, true
}

func previewable(mimeType string) bool {
	return mimeType == "image/png" || mimeType == "image/jpeg" ||
		mimeType == "image/gif" || mimeType == "image/webp"
}

func objectKey(subject Subject, uploadID utilities.ID) string {
	return strings.Join([]string{
		"chat-attachments-v1", "tenants", subject.TenantID.String(),
		"episodes", subject.EpisodeID.String(), "uploads", uploadID.String(),
	}, "/")
}

func signedHeaders(header map[string][]string) (map[string]string, error) {
	result := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) != 1 || strings.TrimSpace(name) == "" {
			return nil, ErrFileTransferFailed
		}
		result[name] = values[0]
	}
	return result, nil
}
