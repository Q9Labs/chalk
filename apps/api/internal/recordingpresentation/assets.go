package recordingpresentation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
)

type assetMaterial struct {
	Asset    Asset
	Existing *ObjectFact
	Body     []byte
}

func addAssetMaterial(material assetMaterial, materials *[]assetMaterial, assetByID map[string]int) error {
	if priorIndex, exists := assetByID[material.Asset.ID]; exists {
		prior := (*materials)[priorIndex]
		if prior.Asset != material.Asset || !sameOptionalObject(prior.Existing, material.Existing) || !bytes.Equal(prior.Body, material.Body) {
			return fmt.Errorf("%w: conflicting asset identity", ErrInvalidCompletionSource)
		}
		return nil
	}
	if len(*materials) >= MaximumAssets {
		return fmt.Errorf("%w: asset count exceeds bounds", ErrInvalidCompletionSource)
	}
	assetByID[material.Asset.ID] = len(*materials)
	*materials = append(*materials, material)
	return nil
}

func presentationObjectPrefix(source CompletionSource) string {
	return recordingobjectkey.Presentation(source.TenantID.String(), source.RecordingID.String(), int64(source.CaptureEpoch), source.PresentationHandle.String())
}

func existingAssetObjectKey(source CompletionSource, assetID, kind, digest string) string {
	identity := sha256.Sum256([]byte(assetID))
	return fmt.Sprintf(
		"%s/assets/%s-%s-%s",
		presentationObjectPrefix(source), kind, digest, hex.EncodeToString(identity[:]),
	)
}
