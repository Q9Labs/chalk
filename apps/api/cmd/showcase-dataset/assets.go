package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func configuredAssetStore() (objectstorage.Store, error) {
	accessKeyID := strings.TrimSpace(os.Getenv(config.R2AccessKeyID))
	accountID := strings.TrimSpace(os.Getenv(config.R2AccountID))
	bucket := strings.TrimSpace(os.Getenv(config.R2Bucket))
	endpoint := strings.TrimSpace(os.Getenv(config.R2Endpoint))
	secretAccessKey := strings.TrimSpace(os.Getenv(config.R2SecretAccessKey))
	configured := accessKeyID != "" || accountID != "" || bucket != "" || endpoint != "" || secretAccessKey != ""
	if !configured {
		return nil, objectstorage.ErrStoreUnavailable
	}
	if accessKeyID == "" || bucket == "" || secretAccessKey == "" || (accountID == "" && endpoint == "") {
		return nil, errors.New("CHALK_R2_ACCESS_KEY_ID, CHALK_R2_SECRET_ACCESS_KEY, CHALK_R2_BUCKET, and either CHALK_R2_ACCOUNT_ID or CHALK_R2_ENDPOINT are required")
	}
	requestTimeout := 30 * time.Second
	if raw := strings.TrimSpace(os.Getenv(config.R2RequestTimeoutMS)); raw != "" {
		milliseconds, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || milliseconds < 1 {
			return nil, fmt.Errorf("%s must be a positive integer", config.R2RequestTimeoutMS)
		}
		requestTimeout = time.Duration(milliseconds) * time.Millisecond
	}
	store, err := r2adapter.NewStore(config.R2Config{
		AccessKeyID:     accessKeyID,
		AccountID:       accountID,
		Bucket:          bucket,
		Endpoint:        endpoint,
		SecretAccessKey: secretAccessKey,
		RequestTimeout:  requestTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("configure Chalk R2 asset store: %w", err)
	}
	return store, nil
}

func uploadBuiltAssets(ctx context.Context, value dataset, assetRoot string, skip bool) error {
	if skip {
		return nil
	}
	store, err := configuredAssetStore()
	if err != nil {
		return fmt.Errorf("built Chalk assets require an R2 store: %w", err)
	}
	service := objectstorage.NewService(store)
	ids := buildIDs(value)
	for _, item := range value.Assets.Assets {
		if item.Status != "built" {
			continue
		}
		path := builtAssetPath(assetRoot, item)
		for _, key := range assetObjectKeys(value, ids, item) {
			if err := uploadAsset(ctx, service, store, item, path, key); err != nil {
				return err
			}
		}
	}
	return nil
}

func uploadAsset(ctx context.Context, service objectstorage.Service, store objectstorage.Store, item asset, path, key string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s for upload: %w", item.AssetKey, err)
	}
	_, putErr := service.PutObject(ctx, objectstorage.PutObjectInput{
		Key:           key,
		Body:          file,
		ContentType:   item.MimeType,
		ContentLength: item.FileSize,
		CacheControl:  "public, max-age=31536000, immutable",
		Metadata: map[string]string{
			"showcase-dataset": showcaseDatasetID,
			"showcase-product": "chalk",
			"showcase-asset":   item.AssetKey,
		},
		IfNoneMatch: true,
	})
	closeErr := file.Close()
	if putErr != nil && !errors.Is(putErr, objectstorage.ErrObjectAlreadyExists) {
		return fmt.Errorf("upload %s: %w", item.AssetKey, putErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s after upload: %w", item.AssetKey, closeErr)
	}
	if putErr == nil {
		return nil
	}
	facts, inspectErr := store.InspectObject(ctx, key)
	if inspectErr != nil {
		return fmt.Errorf("inspect existing %s: %w", item.AssetKey, inspectErr)
	}
	if facts.Size != item.FileSize || facts.ContentType != item.MimeType {
		return fmt.Errorf("existing object %s does not match the manifest", item.AssetKey)
	}
	return verifyRemoteAsset(ctx, store, item, key)
}

func verifyBuiltAssets(ctx context.Context, value dataset, skip bool) error {
	if skip {
		return nil
	}
	store, err := configuredAssetStore()
	if err != nil {
		return fmt.Errorf("verify requires an R2 store for built Chalk assets: %w", err)
	}
	ids := buildIDs(value)
	for _, item := range value.Assets.Assets {
		if item.Status != "built" {
			continue
		}
		for _, key := range assetObjectKeys(value, ids, item) {
			if err := verifyRemoteAsset(ctx, store, item, key); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteBuiltAssets(ctx context.Context, value dataset, skip bool) error {
	if skip {
		return nil
	}
	store, err := configuredAssetStore()
	if err != nil {
		return fmt.Errorf("remove requires an R2 store for built Chalk assets: %w", err)
	}
	ids := buildIDs(value)
	for _, item := range value.Assets.Assets {
		if item.Status != "built" {
			continue
		}
		for _, key := range assetObjectKeys(value, ids, item) {
			if err := deleteAssetWithRetry(ctx, store, item.AssetKey, key); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteAssetWithRetry(ctx context.Context, store objectstorage.Store, assetKey, objectKey string) error {
	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		err := store.DeleteObject(ctx, objectKey)
		if err == nil || errors.Is(err, objectstorage.ErrObjectNotFound) {
			return nil
		}
		if !errors.Is(err, objectstorage.ErrProviderFailed) || attempt == maxAttempts {
			return fmt.Errorf("delete %s: %w", assetKey, err)
		}
		delay := time.Duration(attempt) * time.Second
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return fmt.Errorf("delete %s: %w", assetKey, ctx.Err())
		case <-timer.C:
		}
	}
	return nil
}

func builtAssetPath(assetRoot string, item asset) string {
	return filepath.Join(assetRoot, strings.TrimPrefix(item.LocalPath, "build/assets/"))
}

func assetObjectKeys(value dataset, ids datasetIDs, item asset) []string {
	keys := []string{item.StorageKey}
	if item.Category == "episode-recording" {
		key := nativeRecordingStorageKey(value, ids, item)
		if key != item.StorageKey {
			keys = append(keys, key)
		}
	}
	return keys
}

func nativeRecordingStorageKey(value dataset, ids datasetIDs, item asset) string {
	for _, artifact := range value.Manifest.Records.Artifacts {
		if artifact.RecordingKey != item.AssetKey {
			continue
		}
		episode := value.EpisodeByKey[artifact.EpisodeKey]
		tenantID := ids.TenantIDs[episode.TenantKey]
		suffix := strings.TrimPrefix(item.StorageKey, "showcase-v1/chalk/")
		return "tenants/" + tenantID + "/recordings/showcase-v1/chalk/" + suffix
	}
	return item.StorageKey
}

func verifyRemoteAsset(ctx context.Context, store objectstorage.Store, item asset, key string) error {
	facts, err := store.InspectObject(ctx, key)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", item.AssetKey, err)
	}
	if facts.Size != item.FileSize || facts.ContentType != item.MimeType {
		return fmt.Errorf("object %s does not match the manifest", item.AssetKey)
	}
	object, err := store.GetObject(ctx, key)
	if err != nil {
		return fmt.Errorf("read %s for content verification: %w", item.AssetKey, err)
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, object.Body)
	closeErr := object.Body.Close()
	if copyErr != nil {
		return fmt.Errorf("read %s for content verification: %w", item.AssetKey, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s after content verification: %w", item.AssetKey, closeErr)
	}
	if item.ContentHash != "sha256:"+hex.EncodeToString(digest.Sum(nil)) {
		return fmt.Errorf("object %s content hash does not match the manifest", item.AssetKey)
	}
	return nil
}
