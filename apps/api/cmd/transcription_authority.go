package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type transcriptionObjectAuthority struct {
	storage objectstorage.Service
}

func (a transcriptionObjectAuthority) CreateChunkGETURL(ctx context.Context, input httpapi.ChunkURLInput) (string, error) {
	return a.downloadURL(ctx, input.Key, input.ExpiresIn)
}

func (a transcriptionObjectAuthority) CreateManifestGETURL(ctx context.Context, input httpapi.ManifestURLInput) (string, error) {
	return a.downloadURL(ctx, input.Key, input.ExpiresIn)
}

func (a transcriptionObjectAuthority) CreateResultGETURL(ctx context.Context, input httpapi.FinalizerChunkGETURLInput) (string, error) {
	return a.downloadURL(ctx, input.Key, input.ExpiresIn)
}

func (a transcriptionObjectAuthority) CreateResultPUTURL(ctx context.Context, input httpapi.ResultURLInput) (string, error) {
	return a.uploadURL(ctx, input.Key, input.ContentType, input.ExpiresIn)
}

func (a transcriptionObjectAuthority) CreateFinalArtifactPUTURL(ctx context.Context, input httpapi.FinalizerPUTURLInput) (string, error) {
	return a.uploadURL(ctx, input.Key, input.ContentType, input.ExpiresIn)
}

func (a transcriptionObjectAuthority) CreateDeleteURL(ctx context.Context, input httpapi.CleanupDeleteURLInput) (string, error) {
	signed, err := a.storage.CreateDeleteURL(ctx, objectstorage.CreateDeleteURLInput{Key: input.Key, ExpiresIn: input.ExpiresIn})
	if err != nil {
		return "", err
	}
	if signed.Method != "DELETE" {
		return "", errors.New("object storage returned non-delete authority")
	}
	return signed.URL, nil
}

func (a transcriptionObjectAuthority) VerifyResult(ctx context.Context, input httpapi.ResultVerification) error {
	return a.verify(ctx, input.Key, input.ContentType, input.Size, input.SHA256)
}

func (a transcriptionObjectAuthority) VerifyFinalArtifact(ctx context.Context, input httpapi.FinalizerObjectVerification) error {
	return a.verify(ctx, input.Key, input.ContentType, input.Size, input.SHA256)
}

func (a transcriptionObjectAuthority) VerifyAbsent(ctx context.Context, key string) error {
	object, err := a.storage.GetObject(ctx, key)
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = object.Body.Close()
	return errors.New("object still exists")
}

func (a transcriptionObjectAuthority) downloadURL(ctx context.Context, key string, expiresIn time.Duration) (string, error) {
	signed, err := a.storage.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: key, ExpiresIn: expiresIn})
	if err != nil {
		return "", err
	}
	if signed.Method != "GET" {
		return "", errors.New("object storage returned non-get authority")
	}
	return signed.URL, nil
}

func (a transcriptionObjectAuthority) uploadURL(ctx context.Context, key, contentType string, expiresIn time.Duration) (string, error) {
	signed, err := a.storage.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{Key: key, ContentType: contentType, ExpiresIn: expiresIn})
	if err != nil {
		return "", err
	}
	if signed.Method != "PUT" {
		return "", errors.New("object storage returned non-put authority")
	}
	return signed.URL, nil
}

func (a transcriptionObjectAuthority) verify(ctx context.Context, key, contentType string, size int64, expectedSHA256 []byte) error {
	if size < 1 || len(expectedSHA256) != sha256.Size {
		return errors.New("invalid expected object metadata")
	}
	object, err := a.storage.GetObject(ctx, key)
	if err != nil {
		return err
	}
	defer object.Body.Close()
	if object.Size != size || !strings.EqualFold(object.ContentType, contentType) {
		return errors.New("object metadata mismatch")
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(object.Body, size+1))
	if err != nil {
		return fmt.Errorf("hash object: %w", err)
	}
	if written != size || subtle.ConstantTimeCompare(hash.Sum(nil), expectedSHA256) != 1 {
		return errors.New("object checksum mismatch")
	}
	return nil
}
