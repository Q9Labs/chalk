package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed data/showcase-v1/chalk.json data/showcase-v1/chalk-assets.json data/showcase-v1/checksums.json
var embeddedShowcaseFiles embed.FS

const (
	expectedManifestHash = "40bbfbabcb4e45f053b9ef370620126504fed0d13b1038ab4e20f384bd9d9dc7"
	expectedAssetsHash   = "fddcde6056d7c86eb7554f41779cdec6e462082529fc415a4ce52ea43d87bca9"
)

func loadDataset(options options) (dataset, error) {
	manifestRaw, assetsRaw, checksumsRaw, err := readDatasetFiles(options)
	if err != nil {
		return dataset{}, err
	}

	manifestHash := sha256.Sum256(manifestRaw)
	assetsHash := sha256.Sum256(assetsRaw)
	if hex.EncodeToString(manifestHash[:]) != expectedManifestHash {
		return dataset{}, fmt.Errorf("chalk manifest hash mismatch: got sha256:%s", hex.EncodeToString(manifestHash[:]))
	}
	if hex.EncodeToString(assetsHash[:]) != expectedAssetsHash {
		return dataset{}, fmt.Errorf("chalk asset manifest hash mismatch: got sha256:%s", hex.EncodeToString(assetsHash[:]))
	}

	var manifestValue manifest
	if err := decodeJSON(manifestRaw, &manifestValue); err != nil {
		return dataset{}, fmt.Errorf("decode chalk manifest: %w", err)
	}
	var assetsValue assetManifest
	if err := decodeJSON(assetsRaw, &assetsValue); err != nil {
		return dataset{}, fmt.Errorf("decode chalk asset manifest: %w", err)
	}
	var checksumsValue checksums
	if err := decodeJSON(checksumsRaw, &checksumsValue); err != nil {
		return dataset{}, fmt.Errorf("decode showcase checksums: %w", err)
	}
	if err := validateManifestChecksums(checksumsValue, manifestHash, assetsHash); err != nil {
		return dataset{}, err
	}

	loaded := dataset{
		Manifest:         manifestValue,
		Assets:           assetsValue,
		ManifestRaw:      manifestRaw,
		AssetsRaw:        assetsRaw,
		ManifestHash:     manifestHash,
		AssetsHash:       assetsHash,
		AssetByKey:       make(map[string]asset, len(assetsValue.Assets)),
		TenantByKey:      make(map[string]tenant, len(manifestValue.Records.Tenants)),
		SpaceByKey:       make(map[string]space, len(manifestValue.Records.Spaces)),
		UserByKey:        make(map[string]user, len(manifestValue.Records.Users)),
		AgentByKey:       make(map[string]agent, len(manifestValue.Records.Agents)),
		EpisodeByKey:     make(map[string]episode, len(manifestValue.Records.Episodes)),
		ArtifactByEpKey:  make(map[string]artifact, len(manifestValue.Records.Artifacts)),
		PendingAssetKeys: make(map[string]struct{}),
	}
	if err := validateDataset(&loaded); err != nil {
		return dataset{}, err
	}
	if options.assetRoot != "" {
		if err := validateBuiltAssetFiles(loaded, options.assetRoot); err != nil {
			return dataset{}, err
		}
	}
	return loaded, nil
}

func readDatasetFiles(options options) ([]byte, []byte, []byte, error) {
	manifestPath := options.manifestPath
	assetsPath := options.assetsManifestPath
	checksumsPath := options.checksumsPath
	if manifestPath == "" && assetsPath == "" && checksumsPath == "" {
		manifestRaw, err := embeddedShowcaseFiles.ReadFile("data/showcase-v1/chalk.json")
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read embedded chalk manifest: %w", err)
		}
		assetsRaw, err := embeddedShowcaseFiles.ReadFile("data/showcase-v1/chalk-assets.json")
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read embedded chalk asset manifest: %w", err)
		}
		checksumsRaw, err := embeddedShowcaseFiles.ReadFile("data/showcase-v1/checksums.json")
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read embedded showcase checksums: %w", err)
		}
		return manifestRaw, assetsRaw, checksumsRaw, nil
	}
	if manifestPath == "" || assetsPath == "" || checksumsPath == "" {
		return nil, nil, nil, errors.New("--manifest, --assets-manifest, and --checksums must be supplied together")
	}
	manifestRaw, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read manifest %s: %w", manifestPath, err)
	}
	assetsRaw, err := os.ReadFile(assetsPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read asset manifest %s: %w", assetsPath, err)
	}
	checksumsRaw, err := os.ReadFile(checksumsPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read checksums %s: %w", checksumsPath, err)
	}
	return manifestRaw, assetsRaw, checksumsRaw, nil
}

func decodeJSON(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateManifestChecksums(value checksums, manifestHash, assetsHash [32]byte) error {
	if value.DatasetID != showcaseDatasetID || value.DatasetVersion != showcaseDatasetVersion || value.Algorithm != "sha256" {
		return errors.New("showcase checksums metadata does not describe showcase-v1")
	}
	product, ok := value.Products[showcaseProduct]
	if !ok {
		return errors.New("showcase checksums do not contain Chalk")
	}
	if product.Manifest.ContentHash != "sha256:"+hex.EncodeToString(manifestHash[:]) || product.Assets.ContentHash != "sha256:"+hex.EncodeToString(assetsHash[:]) {
		return errors.New("showcase checksums do not match the supplied Chalk manifests")
	}
	return nil
}

func validateDataset(value *dataset) error {
	manifestValue := value.Manifest
	assetsValue := value.Assets
	if manifestValue.SchemaVersion != 1 || manifestValue.DatasetID != showcaseDatasetID || manifestValue.DatasetVersion != showcaseDatasetVersion || manifestValue.Product != showcaseProduct || manifestValue.AnchorDate == "" {
		return errors.New("chalk manifest metadata is invalid")
	}
	if !manifestValue.OrganizationPolicy.RequiresExplicitKey || !manifestValue.OrganizationPolicy.CreateNewOnly || !manifestValue.OrganizationPolicy.RejectsExistingCustomer || !manifestValue.OrganizationPolicy.ProductionConfirmation || !manifestValue.OrganizationPolicy.RemovalConfirmation {
		return errors.New("chalk manifest organization policy must require explicit new-only confirmations")
	}
	if len(manifestValue.Records.Organizations) != 1 || manifestValue.Records.Organizations[0].ExternalKey == "" {
		return errors.New("chalk manifest must contain one organization")
	}
	if assetsValue.DatasetID != showcaseDatasetID || assetsValue.DatasetVersion != showcaseDatasetVersion || assetsValue.Product != showcaseProduct || assetsValue.AnchorDate != manifestValue.AnchorDate {
		return errors.New("chalk asset manifest metadata is invalid")
	}
	if assetsValue.Counts.Total != len(assetsValue.Assets) || assetsValue.Counts.Built+assetsValue.Counts.PendingProductCapture != assetsValue.Counts.Total {
		return errors.New("chalk asset manifest counts are inconsistent")
	}

	for _, item := range manifestValue.Records.Tenants {
		if err := addUnique(value.TenantByKey, item.ExternalKey, item, "tenant"); err != nil {
			return err
		}
		if item.OrganizationKey != manifestValue.Records.Organizations[0].ExternalKey {
			return fmt.Errorf("tenant %s points to an unknown organization", item.ExternalKey)
		}
	}
	for _, item := range manifestValue.Records.Spaces {
		if err := addUnique(value.SpaceByKey, item.ExternalKey, item, "space"); err != nil {
			return err
		}
		if item.OrganizationKey != manifestValue.Records.Organizations[0].ExternalKey {
			return fmt.Errorf("space %s points to an unknown organization", item.ExternalKey)
		}
		if _, ok := value.TenantByKey[item.TenantKey]; !ok {
			return fmt.Errorf("space %s points to unknown tenant %s", item.ExternalKey, item.TenantKey)
		}
		if item.Visibility != "invited-only" && item.Visibility != "tenant-members" {
			return fmt.Errorf("space %s has unsupported visibility %q", item.ExternalKey, item.Visibility)
		}
	}
	for _, item := range manifestValue.Records.Users {
		if err := addUnique(value.UserByKey, item.ExternalKey, item, "user"); err != nil {
			return err
		}
		if _, ok := value.TenantByKey[item.TenantKey]; !ok {
			return fmt.Errorf("user %s points to unknown tenant %s", item.ExternalKey, item.TenantKey)
		}
		if item.DisplayNameEN == "" || item.DisplayNameAR == "" || item.Locale == "" {
			return fmt.Errorf("user %s is missing a display name or locale", item.ExternalKey)
		}
	}
	for _, item := range manifestValue.Records.Agents {
		if err := addUnique(value.AgentByKey, item.ExternalKey, item, "agent"); err != nil {
			return err
		}
		if _, ok := value.TenantByKey[item.TenantKey]; !ok {
			return fmt.Errorf("agent %s points to unknown tenant %s", item.ExternalKey, item.TenantKey)
		}
		if item.Name == "" || item.Permission == "" {
			return fmt.Errorf("agent %s is incomplete", item.ExternalKey)
		}
	}
	for _, item := range manifestValue.Records.Episodes {
		if err := addUnique(value.EpisodeByKey, item.ExternalKey, item, "episode"); err != nil {
			return err
		}
		if item.OrganizationKey != manifestValue.Records.Organizations[0].ExternalKey {
			return fmt.Errorf("episode %s points to an unknown organization", item.ExternalKey)
		}
		if _, ok := value.TenantByKey[item.TenantKey]; !ok {
			return fmt.Errorf("episode %s points to unknown tenant %s", item.ExternalKey, item.TenantKey)
		}
		selectedSpace, ok := value.SpaceByKey[item.SpaceKey]
		if !ok || selectedSpace.TenantKey != item.TenantKey {
			return fmt.Errorf("episode %s points to an invalid space", item.ExternalKey)
		}
		if _, ok := value.AgentByKey[item.AgentKey]; !ok {
			return fmt.Errorf("episode %s points to unknown agent %s", item.ExternalKey, item.AgentKey)
		}
		if len(item.ParticipantKeys) != 4 || len(item.Chat) != 4 || len(item.Reactions) != 3 || item.Title == "" || item.Outcome == "" {
			return fmt.Errorf("episode %s does not have the expected participant, chat, and reaction shape", item.ExternalKey)
		}
		for _, key := range item.ParticipantKeys {
			selectedUser, ok := value.UserByKey[key]
			if !ok || selectedUser.TenantKey != item.TenantKey {
				return fmt.Errorf("episode %s points to invalid participant %s", item.ExternalKey, key)
			}
		}
		for _, line := range item.Chat {
			if _, ok := value.UserByKey[line.AuthorKey]; !ok || line.Text == "" || line.Locale == "" {
				return fmt.Errorf("episode %s has an invalid chat line", item.ExternalKey)
			}
		}
		for _, reactionValue := range item.Reactions {
			if _, ok := value.UserByKey[reactionValue.UserKey]; !ok || reactionValue.Kind == "" {
				return fmt.Errorf("episode %s has an invalid reaction", item.ExternalKey)
			}
		}
	}
	for _, item := range assetsValue.Assets {
		if err := addUnique(value.AssetByKey, item.AssetKey, item, "asset"); err != nil {
			return err
		}
		if item.DatasetID != showcaseDatasetID || item.Product != showcaseProduct || item.MimeType == "" || item.Category == "" || item.Title == "" {
			return fmt.Errorf("asset %s has invalid metadata", item.AssetKey)
		}
		if item.Status == "built" {
			if item.LocalPath == "" || item.StorageKey == "" || item.FileSize < 1 || !strings.HasPrefix(item.ContentHash, "sha256:") {
				return fmt.Errorf("built asset %s is missing its file proof", item.AssetKey)
			}
		} else if item.Status == "pending-product-capture" {
			value.PendingAssetKeys[item.AssetKey] = struct{}{}
			if item.ExpectedPath == "" || item.LocalPath != "" || item.StorageKey != "" || item.ContentHash != "" || item.FileSize != 0 {
				return fmt.Errorf("pending asset %s must not contain a built file reference", item.AssetKey)
			}
		} else {
			return fmt.Errorf("asset %s has unsupported status %q", item.AssetKey, item.Status)
		}
	}
	if len(value.PendingAssetKeys) != assetsValue.Counts.PendingProductCapture || assetsValue.Counts.PendingProductCapture != 9 {
		return fmt.Errorf("chalk pending capture count must remain nine, got %d", len(value.PendingAssetKeys))
	}
	for _, item := range manifestValue.Records.Artifacts {
		if err := addUnique(value.ArtifactByEpKey, item.EpisodeKey, item, "artifact episode"); err != nil {
			return err
		}
		episodeValue, ok := value.EpisodeByKey[item.EpisodeKey]
		if !ok || episodeValue.TenantKey != item.TenantKey || episodeValue.SpaceKey != item.SpaceKey {
			return fmt.Errorf("artifact %s has invalid episode relation", item.ExternalKey)
		}
		for _, key := range []string{item.TranscriptKey, item.WhiteboardKey, item.RecordingKey} {
			if key == "" {
				continue
			}
			assetValue, ok := value.AssetByKey[key]
			if !ok {
				return fmt.Errorf("artifact %s points to unknown asset %s", item.ExternalKey, key)
			}
			if assetValue.Status == "pending-product-capture" && !item.CaptureRequired {
				return fmt.Errorf("artifact %s has pending asset without captureRequired", item.ExternalKey)
			}
		}
	}

	if len(manifestValue.Records.Tenants) != 8 || len(manifestValue.Records.Spaces) != 30 || len(manifestValue.Records.Users) != 180 || len(manifestValue.Records.Agents) != 40 || len(manifestValue.Records.Episodes) != 150 || len(manifestValue.Records.Artifacts) != 30 {
		return errors.New("chalk manifest record counts changed from the agreed showcase shape")
	}
	if assetsValue.Counts.Total != 76 || assetsValue.Counts.Built != 67 {
		return errors.New("chalk asset manifest counts changed from the agreed showcase shape")
	}
	return nil
}

func addUnique[T any](destination map[string]T, key string, value T, kind string) error {
	if key == "" {
		return fmt.Errorf("%s has an empty external key", kind)
	}
	if _, exists := destination[key]; exists {
		return fmt.Errorf("duplicate %s external key %s", kind, key)
	}
	destination[key] = value
	return nil
}

func validateBuiltAssetFiles(value dataset, assetRoot string) error {
	root, err := filepath.Abs(assetRoot)
	if err != nil {
		return fmt.Errorf("resolve asset root: %w", err)
	}
	for _, item := range value.Assets.Assets {
		if item.Status != "built" {
			continue
		}
		relative := strings.TrimPrefix(item.LocalPath, "build/assets/")
		if relative == item.LocalPath || filepath.IsAbs(relative) || strings.Contains(relative, "..") {
			return fmt.Errorf("asset %s has an unsafe local path", item.AssetKey)
		}
		path := filepath.Join(root, relative)
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("asset %s is missing at %s: %w", item.AssetKey, path, err)
		}
		if !info.Mode().IsRegular() || info.Size() != item.FileSize {
			return fmt.Errorf("asset %s file size mismatch: got %d want %d", item.AssetKey, info.Size(), item.FileSize)
		}
		file, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("open asset %s: %w", item.AssetKey, err)
		}
		digest := sha256.New()
		_, copyErr := io.Copy(digest, file)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("hash asset %s: %w", item.AssetKey, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close asset %s: %w", item.AssetKey, closeErr)
		}
		got := hex.EncodeToString(digest.Sum(nil))
		if item.ContentHash != "sha256:"+got {
			return fmt.Errorf("asset %s content hash mismatch: got sha256:%s want %s", item.AssetKey, got, item.ContentHash)
		}
	}
	return nil
}

func pendingAssetKeys(value dataset) []string {
	keys := make([]string, 0, len(value.PendingAssetKeys))
	for key := range value.PendingAssetKeys {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
