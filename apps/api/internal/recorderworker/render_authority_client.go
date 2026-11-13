package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (c *ControlPlaneClient) ResolveRenderInput(ctx context.Context, authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
	if err := authority.Validate(); err != nil {
		return recordingrender.ResolvedInput{}, ErrInvalidControlPlaneRequest
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteRenderInputsResolve.Path(), renderAuthorityBody(authority), ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.ResolvedInput{}, err
	}
	var response recorderprotocol.RenderInputResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.ResolvedInput{}, ProtocolError{Err: err}
	}
	return decodeResolvedRenderInput(authority, response)
}

func (c *ControlPlaneClient) AccessRenderKey(ctx context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.DataKey{}, ErrInvalidControlPlaneRequest
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteRenderKeysAccess.Path(), recorderprotocol.RenderKeyAccessRequest{RenderAuthority: renderAuthorityBody(input.Authority), RequestedCaptureEpoch: input.CaptureEpoch}, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.DataKey{}, err
	}
	var response struct {
		KeyHandle    string `json:"key_handle"`
		Plaintext    string `json:"plaintext"`
		CaptureEpoch int64  `json:"capture_epoch"`
	}
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.DataKey{}, ProtocolError{Err: err}
	}
	keyID, idErr := utilities.ParseID(response.KeyHandle)
	plaintext, keyErr := base64.StdEncoding.DecodeString(response.Plaintext)
	if idErr != nil || keyErr != nil || keyID.IsZero() || response.CaptureEpoch != input.CaptureEpoch || len(plaintext) != 32 {
		clear(plaintext)
		return recordingrender.DataKey{}, ProtocolError{Err: errors.New("recording render key response authority mismatch")}
	}
	return recordingrender.DataKey{KeyHandle: keyID, Plaintext: plaintext, CaptureEpoch: response.CaptureEpoch}, nil
}

func (c *ControlPlaneClient) ReserveRenderObject(ctx context.Context, input recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.ReservedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := recorderprotocol.RenderObjectReserveRequest{RenderAuthority: renderAuthorityBody(input.Authority), Purpose: string(input.Purpose), ReservationRequestID: input.ReservationRequestID.String()}
	body, _, err := c.doRenderFinish(ctx, recorderprotocol.RouteRenderObjectsReserve.Path(), payload)
	if err != nil {
		return recordingrender.ReservedObject{}, err
	}
	var response recorderprotocol.RenderObjectReserveResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.ReservedObject{}, ProtocolError{Err: err}
	}
	allocationID, parseErr := utilities.ParseID(response.AllocationID)
	if parseErr != nil || response.Purpose != string(input.Purpose) || response.AllocationVersion <= 0 || strings.TrimSpace(response.ObjectKey) == "" {
		return recordingrender.ReservedObject{}, ProtocolError{Err: errors.New("recording render reservation response")}
	}
	return recordingrender.ReservedObject{AllocationID: allocationID, ObjectKey: response.ObjectKey, Purpose: input.Purpose, AllocationVersion: response.AllocationVersion}, nil
}

func (c *ControlPlaneClient) FinalizeRenderObject(ctx context.Context, input recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.FinalizedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := recorderprotocol.RenderObjectFinalizeRequest{RenderAuthority: renderAuthorityBody(input.Authority), AllocationID: input.AllocationID.String(), Purpose: string(input.Purpose), ContentType: input.ContentType, ByteSize: input.ByteSize, SHA256: hex.EncodeToString(input.SHA256), DurationMillis: input.DurationMillis}
	body, _, err := c.doRenderFinish(ctx, recorderprotocol.RouteRenderObjectsFinalize.Path(), payload)
	if err != nil {
		return recordingrender.FinalizedObject{}, err
	}
	var response recorderprotocol.RenderObjectFinalizeResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.FinalizedObject{}, ProtocolError{Err: err}
	}
	return decodeFinalizedRenderObject(input, response)
}

func (c *ControlPlaneClient) CommitRenderObject(ctx context.Context, input recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.CommittedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := recorderprotocol.RenderObjectCommitRequest{RenderAuthority: renderAuthorityBody(input.Authority), AllocationID: input.AllocationID.String(), UploadToken: input.UploadToken}
	body, _, err := c.doRenderFinish(ctx, recorderprotocol.RouteRenderObjectsCommit.Path(), payload)
	if err != nil {
		return recordingrender.CommittedObject{}, err
	}
	var response recorderprotocol.RenderObjectCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.CommittedObject{}, ProtocolError{Err: err}
	}
	return decodeCommittedRenderObject(input.AllocationID, response)
}

func (c *ControlPlaneClient) CommitRender(ctx context.Context, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.CommitResult{}, ErrInvalidControlPlaneRequest
	}
	payload := recorderprotocol.RenderCommitRequest{
		VideoDegradation:   input.VideoDegradation,
		RenderAuthority:    renderAuthorityBody(input.Authority),
		CommitDigest:       hex.EncodeToString(input.CommitDigest),
		PresentationSHA256: hex.EncodeToString(input.PresentationSHA256),
		DurationMillis:     input.DurationMillis,
		Video:              renderObjectReferenceBody(input.Video),
		FFprobeFactsDigest: hex.EncodeToString(input.FFprobeFactsDigest),
	}
	payload.TranscriptionSource = renderTranscriptionSourceBody(input.TranscriptionSource)
	body, _, err := c.doRenderFinish(ctx, recorderprotocol.RouteRendersCommit.Path(), payload)
	if err != nil {
		return recordingrender.CommitResult{}, err
	}
	var response recorderprotocol.RenderCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.CommitResult{}, ProtocolError{Err: err}
	}
	return decodeRenderCommit(input, response)
}

func (c *ControlPlaneClient) CommitTranscriptionPreparation(ctx context.Context, input recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error) {
	if err := input.Validate(); err != nil {
		return nil, ErrInvalidControlPlaneRequest
	}
	payload := recorderprotocol.TranscriptionCommitRequest{
		RenderAuthority:     renderAuthorityBody(input.Authority),
		CommitDigest:        hex.EncodeToString(input.CommitDigest),
		PresentationSHA256:  hex.EncodeToString(input.PresentationSHA256),
		DurationMillis:      input.DurationMillis,
		TranscriptionSource: renderTranscriptionSourceBody(input.TranscriptionSource),
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteRendersTranscriptionDone.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return nil, err
	}
	var response recorderprotocol.TranscriptionCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return nil, ProtocolError{Err: err}
	}
	return decodeTranscriptionPreparationCommit(input, response)
}

func (c *ControlPlaneClient) UploadRenderObject(ctx context.Context, signed objectstorage.SignedURL, reader io.Reader, byteSize int64) error {
	if reader == nil || byteSize <= 0 {
		return ErrInvalidControlPlaneRequest
	}
	return c.putSignedObject(ctx, signed, io.LimitReader(reader, byteSize+1), byteSize)
}

func (c *ControlPlaneClient) putSignedObject(ctx context.Context, signed objectstorage.SignedURL, body io.Reader, byteSize int64) error {
	if c == nil || c.uploader == nil || signed.Method != http.MethodPut || !signed.ExpiresAt.After(time.Now().UTC()) {
		return ErrInvalidControlPlaneRequest
	}
	endpoint, err := validateRecordingUploadURL(signed.URL)
	if err != nil {
		return ErrInvalidControlPlaneRequest
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), body)
	if err != nil {
		return ProtocolError{Err: err}
	}
	request.ContentLength = byteSize
	if err := applySignedObjectHeaders(request, signed.SignedHeader); err != nil {
		return err
	}
	response, err := c.uploader.Do(request)
	if err != nil {
		return TransportError{Err: errors.Join(ErrRecordingObjectUpload, err)}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%w: %w", ErrRecordingObjectUpload, classifyHTTPError(response.StatusCode))
	}
	return nil
}

func (c *ControlPlaneClient) DownloadRenderObject(ctx context.Context, object recordingrender.DownloadableObject, outputPath string) error {
	if c == nil || c.uploader == nil || object.Download.Method != http.MethodGet || object.ByteSize <= 0 || len(object.SHA256) != sha256.Size || !object.Download.ExpiresAt.After(time.Now().UTC()) || strings.TrimSpace(outputPath) == "" {
		return ErrInvalidControlPlaneRequest
	}
	endpoint, err := validateRecordingUploadURL(object.Download.URL)
	if err != nil {
		return ErrInvalidControlPlaneRequest
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ProtocolError{Err: err}
	}
	if err := applySignedObjectHeaders(request, object.Download.SignedHeaders); err != nil {
		return err
	}
	response, err := c.uploader.Do(request)
	if err != nil {
		return TransportError{Err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return classifyHTTPError(response.StatusCode)
	}
	file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(outputPath)
		}
	}()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, object.ByteSize+1))
	if copyErr != nil || written != object.ByteSize || !bytes.Equal(hash.Sum(nil), object.SHA256) {
		return errors.New("downloaded recording render object facts do not match authority")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}
