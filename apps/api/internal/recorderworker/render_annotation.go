package recorderworker

import (
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

func findAnnotationSidecar(assets []recordingpresentation.Asset, assetDirectory string) (*FrameAnnotationSidecar, error) {
	var sidecar *FrameAnnotationSidecar
	for _, asset := range assets {
		if asset.Kind == recordingpresentation.ScreenAnnotationAssetKind {
			if sidecar != nil {
				return nil, fmt.Errorf("%w: multiple frozen screen annotation assets", ErrInvalidProductionRenderAttempt)
			}
			sidecar = &FrameAnnotationSidecar{Path: filepath.Join(assetDirectory, asset.SHA256), SHA256: asset.SHA256}
		}
	}
	return sidecar, nil
}

func validateAnnotationSidecar(workspaceDirectory string, sidecar *FrameAnnotationSidecar) error {
	if sidecar != nil {
		if !isLowerSHA256(sidecar.SHA256) || !filepath.IsAbs(sidecar.Path) || !pathWithin(workspaceDirectory, sidecar.Path) {
			return errors.New("recording annotation sidecar is not a verified workspace input")
		}
	}
	return nil
}

func videoFrameRequest(resolved recordingrender.ResolvedInput, timeline recordingpresentation.Timeline, decoded recordingdecode.Result, workspaceDirectory, presentationPath, assetDirectory string) (FrameRenderRequest, error) {
	if len(decoded.Index.Sources) == 0 {
		return FrameRenderRequest{}, fmt.Errorf("%w: recording has no decodable video or audio", recordingdecode.ErrDecode)
	}
	frameRequest := FrameRenderRequest{
		SchemaVersion: FrameRenderRequestVersion, RecordingID: resolved.RecordingID.String(), EpisodeID: resolved.EpisodeID.String(),
		WorkspaceDirectory: workspaceDirectory, PresentationPath: presentationPath, PresentationSHA256: hex.EncodeToString(resolved.PresentationSHA256),
		AssetDirectory: assetDirectory, DecodedMediaPath: decoded.IndexPath,
		DecodedMediaSHA256: decoded.IndexSHA256, Width: timeline.Initial.Profile.Viewport.Width, Height: timeline.Initial.Profile.Viewport.Height,
		FPS: nativeRenderFPS, DurationMs: resolved.DurationMillis,
	}
	sidecar, err := findAnnotationSidecar(timeline.Assets, assetDirectory)
	if err != nil {
		return FrameRenderRequest{}, err
	}
	frameRequest.AnnotationSidecar = sidecar
	return frameRequest, nil
}
