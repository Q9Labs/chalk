package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mtls"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

func runWorker(environment, controlPlaneURL, workerCertificate, workerKey, serverCA, serverName string) error {
	if strings.TrimSpace(environment) == "" {
		return errors.New("--environment or CHALK_RECORDER_ENVIRONMENT is required")
	}
	if strings.TrimSpace(controlPlaneURL) == "" {
		return errors.New("--control-plane-url or CHALK_RECORDER_CONTROL_PLANE_URL is required")
	}
	tlsConfig, err := mtls.LoadClientConfig(workerCertificate, workerKey, serverCA, serverName)
	if err != nil {
		return fmt.Errorf("load recorder worker mTLS config: %w", err)
	}
	controlHTTP := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute}, Timeout: 30 * time.Second}
	controlBase, err := parseCommandBaseURL(controlPlaneURL)
	if err != nil {
		return err
	}
	ports, err := newHTTPRecorderPorts(controlBase, controlHTTP)
	if err != nil {
		return fmt.Errorf("create recorder control-plane client: %w", err)
	}
	control := ports.authority
	factory, err := recorderworker.NewPionCaptureAttemptFactory(recorderworker.PionCaptureAttemptFactoryConfig{
		Signaling: control,
		Plans:     control,
		Keys:      ports,
		Objects:   ports,
		Bundles:   ports,
		Lifecycle: ports,
		Attempt:   recorderworker.CaptureAttemptConfig{Environment: environment},
	})
	if err != nil {
		return fmt.Errorf("create recorder capture factory: %w", err)
	}
	daemon, err := recorderworker.NewCaptureDaemon(control, factory, recorderworker.CaptureDaemonConfig{})
	if err != nil {
		return fmt.Errorf("create recorder capture daemon: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return daemon.Run(ctx)
}

func parseCommandBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("control-plane URL must be an HTTPS origin without credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, nil
}

type httpRecorderPorts struct {
	object    *http.Client
	authority *recorderworker.ControlPlaneClient
}

func newHTTPRecorderPorts(base *url.URL, control *http.Client) (*httpRecorderPorts, error) {
	objectTransport := &http.Transport{Proxy: http.ProxyFromEnvironment, ForceAttemptHTTP2: true, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute}
	object := &http.Client{Transport: objectTransport, Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	authority, err := recorderworker.NewControlPlaneClientWithURLAndUploader(base, control, object)
	if err != nil {
		return nil, err
	}
	return &httpRecorderPorts{object: object, authority: authority}, nil
}

func (p *httpRecorderPorts) AccessKey(ctx context.Context, input recorderworker.CaptureKeyRequest) (recorderworker.CaptureDataKey, error) {
	authority, err := captureKeyAuthority(input)
	if err != nil {
		return recorderworker.CaptureDataKey{}, err
	}
	key, err := p.authority.AccessRecordingKey(ctx, authority)
	if err != nil {
		return recorderworker.CaptureDataKey{}, err
	}
	return recorderworker.CaptureDataKey{Plaintext: key.Plaintext, EncryptionContextDigest: key.ContextDigest}, nil
}

func (p *httpRecorderPorts) Reserve(ctx context.Context, input recorderworker.BundleReserveRequest) (recorderworker.BundleReservation, error) {
	authority, err := captureObjectAuthority(input)
	if err != nil {
		return recorderworker.BundleReservation{}, err
	}
	allocation, err := p.authority.ReserveRecordingObject(ctx, recordingobjects.ReserveInput{Authority: authority, ReservationRequestID: input.ReservationRequestID, EncryptionContextDigest: append([]byte(nil), input.EncryptionContextDigest...)})
	if err != nil {
		return recorderworker.BundleReservation{}, err
	}
	return recorderworker.BundleReservation{ReservationID: allocation.ID, Sequence: uint64(allocation.SequenceNumber), AllocationVersion: allocation.AllocationVersion, ObjectKey: allocation.ObjectKey}, nil
}

func (p *httpRecorderPorts) Finalize(ctx context.Context, input recorderworker.CaptureBundleFinalize) (recorderworker.CaptureBundleUpload, error) {
	authority, err := captureObjectAuthority(input.Authority)
	if err != nil {
		return recorderworker.CaptureBundleUpload{}, err
	}
	checksum, err := captureDigest(input.ObjectSHA256)
	if err != nil {
		return recorderworker.CaptureBundleUpload{}, fmt.Errorf("decode recording object checksum: %w", err)
	}
	manifest := input.Bundle.Manifest
	result, err := p.authority.FinalizeRecordingObject(ctx, recordingobjects.FinalizeInput{
		Authority: authority, AllocationID: input.Reservation.ReservationID,
		ExpectedByteSize: input.ObjectSize, ExpectedChecksumSHA256: checksum, ContentType: input.ContentType,
		ExpiresAt: time.Now().UTC().Add(recordingobjects.DefaultAllocationTTL), Codec: input.Codec, Layer: input.Layer,
		MonotonicStartMillis: manifest.MonotonicRange.StartMilliseconds, MonotonicEndMillis: manifest.MonotonicRange.EndMilliseconds,
		MediaStartMillis: manifest.MediaRange.StartMilliseconds, MediaEndMillis: manifest.MediaRange.EndMilliseconds,
	})
	if err != nil {
		return recorderworker.CaptureBundleUpload{}, err
	}
	return recorderworker.CaptureBundleUpload{Reservation: input.Reservation, UploadToken: result.UploadToken, SignedURL: result.UploadURL}, nil
}

func (p *httpRecorderPorts) Upload(ctx context.Context, input recorderworker.CaptureObjectUpload) error {
	return p.authority.UploadRecordingObject(ctx, input.Upload.SignedURL, input.Body)
}

func (p *httpRecorderPorts) Commit(ctx context.Context, input recorderworker.CaptureBundleCommit) error {
	authority, err := captureObjectAuthority(input.Authority)
	if err != nil {
		return err
	}
	manifestDigest, err := captureDigest(input.Bundle.ManifestDigest)
	if err != nil {
		return fmt.Errorf("decode recording bundle manifest digest: %w", err)
	}
	manifest := input.Bundle.Manifest
	committed, err := p.authority.CommitRecordingObject(ctx, recordingobjects.CommitInput{
		Authority: authority, AllocationID: input.Reservation.ReservationID, UploadToken: input.UploadToken, ManifestDigest: manifestDigest,
		MonotonicStartMillis: manifest.MonotonicRange.StartMilliseconds, MonotonicEndMillis: manifest.MonotonicRange.EndMilliseconds,
		MediaStartMillis: manifest.MediaRange.StartMilliseconds, MediaEndMillis: manifest.MediaRange.EndMilliseconds,
	})
	if err != nil {
		return err
	}
	if committed.ID != input.Reservation.ReservationID || committed.SequenceNumber != int64(input.Reservation.Sequence) || committed.AllocationVersion != input.Reservation.AllocationVersion || committed.ObjectKey != input.Reservation.ObjectKey {
		return errors.New("recording object commit response changed the reserved authority")
	}
	return nil
}

func captureKeyAuthority(input recorderworker.CaptureKeyRequest) (recordingkeys.Authority, error) {
	digest, err := captureDigest(input.EnvelopeDigest)
	if err != nil || input.CaptureEpoch > math.MaxInt64 {
		return recordingkeys.Authority{}, recorderworker.ErrInvalidCaptureAttempt
	}
	return recordingkeys.Authority{TenantID: input.TenantID, EpisodeID: input.EpisodeID, RecordingID: input.RecordingID, JobID: input.JobID, KeyHandle: input.KeyHandle, AttemptCount: input.Attempt, FencingGeneration: input.FencingGeneration, CaptureEpoch: int64(input.CaptureEpoch), EnvelopeDigest: digest, LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner, LeaseExpiresAt: input.LeaseExpiresAt}, nil
}

func captureObjectAuthority(input recorderworker.BundleReserveRequest) (recordingobjects.Authority, error) {
	digest, err := captureDigest(input.EnvelopeDigest)
	if err != nil || input.CaptureEpoch > math.MaxInt64 {
		return recordingobjects.Authority{}, recorderworker.ErrInvalidCaptureAttempt
	}
	return recordingobjects.Authority{TenantID: input.TenantID, EpisodeID: input.EpisodeID, RecordingID: input.RecordingID, JobID: input.JobID, ObjectHandle: input.ObjectHandle, AttemptCount: input.Attempt, FencingGeneration: input.FencingGeneration, CaptureEpoch: int64(input.CaptureEpoch), EnvelopeDigest: digest, LeaseToken: input.LeaseToken, LeaseOwner: input.LeaseOwner, LeaseExpiresAt: input.LeaseExpiresAt}, nil
}

func captureDigest(value string) ([]byte, error) {
	if value != strings.ToLower(value) {
		return nil, errors.New("digest is not canonical")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return nil, errors.New("digest must be a lowercase SHA-256 value")
	}
	return decoded, nil
}

func (p *httpRecorderPorts) Ready(ctx context.Context, input recorderworker.CaptureReadyEvent) error {
	return p.authority.ReportCaptureReady(ctx, input)
}

func (p *httpRecorderPorts) Stopped(ctx context.Context, input recorderworker.CaptureStoppedEvent) error {
	return p.authority.ReportCaptureStopped(ctx, input)
}

var _ recorderworker.CaptureKeyPort = (*httpRecorderPorts)(nil)
var _ recorderworker.CaptureObjectPort = (*httpRecorderPorts)(nil)
var _ recorderworker.CaptureBundleSink = (*httpRecorderPorts)(nil)
var _ recorderworker.CaptureLifecyclePort = (*httpRecorderPorts)(nil)
