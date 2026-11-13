package recordingrender

import (
	"errors"
)

var (
	ErrInvalidRequest           = errors.New("invalid recording render request")
	ErrAuthorityMismatch        = errors.New("recording render authority mismatch")
	ErrLeaseStale               = errors.New("recording render lease is stale")
	ErrInputNotFound            = errors.New("recording render input not found")
	ErrInputIncomplete          = errors.New("recording render input is incomplete")
	ErrInputTooLarge            = errors.New("recording render input exceeds bounds")
	ErrKeyNotFound              = errors.New("recording render key not found")
	ErrAllocationNotFound       = errors.New("recording render allocation not found")
	ErrAllocationConflict       = errors.New("recording render allocation conflict")
	ErrAllocationExpired        = errors.New("recording render allocation expired")
	ErrObjectFactsMismatch      = errors.New("recording render object facts mismatch")
	ErrCommitConflict           = errors.New("recording render commit conflict")
	ErrTranscriptionUnavailable = errors.New("recording render transcription runtime unavailable")
	ErrRepositoryUnavailable    = errors.New("recording render repository unavailable")
	ErrStorageUnavailable       = errors.New("recording render storage unavailable")
	ErrKMSUnavailable           = errors.New("recording render kms unavailable")
)
