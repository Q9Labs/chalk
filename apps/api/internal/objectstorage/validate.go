package objectstorage

import (
	"encoding/base64"
	"mime"
	"strings"
	"unicode"
)

const maxObjectKeyBytes = 1024

const (
	maxMetadataEntries    = 16
	maxMetadataKeyBytes   = 64
	maxMetadataValueBytes = 256
)

func normalizePutObjectInput(input *PutObjectInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key

	contentType, err := contentType(input.ContentType)
	if err != nil {
		return ErrInvalidContentType
	}
	input.ContentType = contentType

	if input.Body == nil || input.ContentLength < 0 {
		return ErrInvalidObjectBody
	}
	if err := validateMetadata(input.Metadata); err != nil {
		return err
	}

	return nil
}

func normalizeCreateUploadURLInput(input *CreateUploadURLInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key

	contentType, err := contentType(input.ContentType)
	if err != nil {
		return ErrInvalidContentType
	}
	input.ContentType = contentType

	if input.ExpiresIn <= 0 {
		return ErrInvalidURLExpiration
	}
	if input.ContentLength < 0 || (input.IfNoneMatch && input.ContentLength == 0) {
		return ErrInvalidObjectSize
	}
	if input.ChecksumSHA256 != "" {
		checksum, err := base64.StdEncoding.Strict().DecodeString(input.ChecksumSHA256)
		if err != nil || len(checksum) != 32 {
			return ErrInvalidChecksum
		}
	}
	if err := validateMetadata(input.Metadata); err != nil {
		return err
	}

	return nil
}

func normalizeCreateDownloadURLInput(input *CreateDownloadURLInput) error {
	key, err := objectKey(input.Key)
	if err != nil {
		return ErrInvalidObjectKey
	}
	input.Key = key
	input.VersionID = strings.TrimSpace(input.VersionID)
	if strings.ContainsFunc(input.VersionID, unicode.IsControl) {
		return ErrInvalidObjectKey
	}
	input.IfMatch = strings.TrimSpace(input.IfMatch)
	if strings.ContainsFunc(input.IfMatch, unicode.IsControl) {
		return ErrInvalidChecksum
	}

	if input.ExpiresIn <= 0 {
		return ErrInvalidURLExpiration
	}
	input.ContentDisposition = strings.TrimSpace(input.ContentDisposition)
	if strings.ContainsAny(input.ContentDisposition, "\r\n") {
		return ErrInvalidDisposition
	}

	return nil
}

func ValidateKey(value string) error {
	_, err := objectKey(value)
	return err
}

func objectKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxObjectKeyBytes || strings.HasPrefix(value, "/") {
		return "", ErrInvalidObjectKey
	}

	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrInvalidObjectKey
		}
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return "", ErrInvalidObjectKey
		}
	}

	return value, nil
}

func contentType(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsFunc(value, unicode.IsControl) {
		return "", ErrInvalidContentType
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil || !strings.Contains(mediaType, "/") {
		return "", ErrInvalidContentType
	}

	return value, nil
}

func validateMetadata(metadata map[string]string) error {
	if len(metadata) > maxMetadataEntries {
		return ErrInvalidMetadata
	}

	for key, value := range metadata {
		if key == "" || len(key) > maxMetadataKeyBytes || len(value) > maxMetadataValueBytes {
			return ErrInvalidMetadata
		}
		for _, char := range key {
			if !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '-' && char != '_' {
				return ErrInvalidMetadata
			}
		}
		if strings.ContainsFunc(value, unicode.IsControl) {
			return ErrInvalidMetadata
		}
	}

	return nil
}
