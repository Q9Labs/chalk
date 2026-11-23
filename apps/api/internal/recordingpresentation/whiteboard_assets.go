package recordingpresentation

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

func addReferencedWhiteboardFiles(sceneID string, elements []whiteboardElementWire, source CompletionSource, whiteboardFiles map[string]ObjectFact, materials *[]assetMaterial, assetByID map[string]int) error {
	for index, element := range elements {
		if element.Deleted {
			continue
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(element.Payload, &payload); err != nil {
			return fmt.Errorf("%w: invalid whiteboard element payload", ErrInvalidCompletionSource)
		}
		raw, exists := payload["fileId"]
		if !exists || bytes.Equal(raw, []byte("null")) {
			continue
		}
		var fileID string
		if err := json.Unmarshal(raw, &fileID); err != nil || fileID == "" {
			return fmt.Errorf("%w: invalid whiteboard file identity", ErrInvalidCompletionSource)
		}
		// Namespace the exported file ID, not the live scene. Existing renderers
		// derive the asset ID from this payload and need no format change.
		scopedID := sceneID + ":" + fileID
		assetID := "whiteboard_file:" + scopedID
		if _, exported := assetByID[assetID]; !exported {
			object, exists := whiteboardFiles[scopedID]
			if !exists {
				return fmt.Errorf("%w: missing whiteboard file asset", ErrInvalidCompletionSource)
			}
			digest := hex.EncodeToString(object.SHA256)
			asset := Asset{
				ID: assetID, Kind: "whiteboard_file",
				ObjectKey:   existingAssetObjectKey(source, assetID, "whiteboard_file", digest),
				ContentType: object.ContentType, ByteSize: object.ByteSize, SHA256: digest,
			}
			if err := addAssetMaterial(assetMaterial{Asset: asset, Existing: cloneObjectFactPointer(object)}, materials, assetByID); err != nil {
				return err
			}
		}
		payload["fileId"], _ = json.Marshal(scopedID)
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("%w: encode whiteboard file reference: %v", ErrInvalidCompletionSource, err)
		}
		elements[index].Payload = encoded
	}
	return nil
}

func initialSharedContent(whiteboard *whiteboardState, screen SharedContent, source CompletionSource, whiteboardFiles map[string]ObjectFact, materials *[]assetMaterial, assetByID map[string]int) (SharedContent, error) {
	if whiteboard == nil || !whiteboard.Presenting {
		return screen, nil
	}
	assetID, err := addWhiteboardStateAsset(*whiteboard, source, whiteboardFiles, materials, assetByID)
	if err != nil {
		return SharedContent{}, err
	}
	return SharedContent{Kind: "whiteboard", SceneID: whiteboard.SceneID, Revision: whiteboard.Revision, StateAssetID: assetID}, nil
}
