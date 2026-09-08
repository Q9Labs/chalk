package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

type renderInputDownloader struct {
	attempt *ProductionRenderAttempt
	facts   [sha256.Size]byte
	objects map[string]recordingrender.DownloadableObject
}

func newRenderInputDownloader(attempt *ProductionRenderAttempt, input recordingrender.ResolvedInput) (*renderInputDownloader, error) {
	facts, err := renderInputFactsDigest(input)
	if err != nil {
		return nil, err
	}
	downloads := &renderInputDownloader{attempt: attempt, facts: facts}
	downloads.replaceGrants(input)
	return downloads, nil
}

func (downloads *renderInputDownloader) replaceGrants(input recordingrender.ResolvedInput) {
	downloads.objects = make(map[string]recordingrender.DownloadableObject, 2+len(input.Assets)+len(input.Capture))
	downloads.objects[input.Presentation.ObjectKey] = input.Presentation
	downloads.objects[input.AssetManifest.ObjectKey] = input.AssetManifest
	for _, object := range input.Assets {
		downloads.objects[object.ObjectKey] = object
	}
	for _, object := range input.Capture {
		downloads.objects[object.ObjectKey] = recordingrender.DownloadableObject{ObjectFacts: object.ObjectFacts, Download: object.Download}
	}
}

func (downloads *renderInputDownloader) download(ctx context.Context, expected recordingrender.DownloadableObject, path string) error {
	object, ok := downloads.objects[expected.ObjectKey]
	if !ok {
		return fmt.Errorf("%w: missing recording download", ErrInvalidProductionRenderAttempt)
	}
	// Grants are shorter lived than a renewable worker lease. Refresh the batch
	// only near expiry, under the latest lease, without changing immutable input.
	if !object.Download.ExpiresAt.After(downloads.attempt.config.Now().Add(30 * time.Second)) {
		input, err := withRenderAuthority(downloads.attempt, func(authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
			return downloads.attempt.config.Control.ResolveRenderInput(ctx, authority)
		})
		if err != nil {
			return fmt.Errorf("refresh recording input grants: %w", err)
		}
		facts, err := renderInputFactsDigest(input)
		if err != nil {
			return err
		}
		if facts != downloads.facts {
			return fmt.Errorf("%w: recording input changed during grant refresh", ErrInvalidProductionRenderAttempt)
		}
		downloads.replaceGrants(input)
		object = downloads.objects[expected.ObjectKey]
	}
	if !object.Download.ExpiresAt.After(downloads.attempt.config.Now()) {
		return recordingrender.ErrLeaseStale
	}
	return downloads.attempt.config.Control.DownloadRenderObject(ctx, object, path)
}

func renderInputFactsDigest(input recordingrender.ResolvedInput) ([sha256.Size]byte, error) {
	input.Presentation.Download = recordingrender.DownloadGrant{}
	input.AssetManifest.Download = recordingrender.DownloadGrant{}
	input.Assets = append([]recordingrender.DownloadableObject(nil), input.Assets...)
	input.Capture = append([]recordingrender.DownloadableCaptureObject(nil), input.Capture...)
	for index := range input.Assets {
		input.Assets[index].Download = recordingrender.DownloadGrant{}
	}
	for index := range input.Capture {
		input.Capture[index].Download = recordingrender.DownloadGrant{}
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("encode immutable recording input: %w", err)
	}
	return sha256.Sum256(encoded), nil
}
