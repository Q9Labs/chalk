package recording

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

var (
	ErrRecordingNotFound = errors.New("recording not found")
	ErrRecordingNotReady = errors.New("recording not ready")
	ErrNoActiveRecording = errors.New("no active recording found")
	ErrRoomNotFound      = errors.New("room not found")
)

type CloudflareClient interface {
	StartRecording(ctx context.Context, meetingID string, req cloudflare.StartRecordingRequest) (*cloudflare.Recording, error)
	StopRecording(ctx context.Context, recordingID string) (*cloudflare.Recording, error)
	GetRecording(ctx context.Context, recordingID string) (*cloudflare.Recording, error)
	ListRecordingsByMeeting(ctx context.Context, meetingID string) ([]cloudflare.Recording, error)
}

type StorageClient interface {
	GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error)
	Download(ctx context.Context, key string) (io.ReadCloser, error)
	Upload(ctx context.Context, key string, reader io.Reader, contentType string) error
	Delete(ctx context.Context, key string) error
}

type RoomStateManager interface {
	SetRecordingState(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error
}

type WebSocketHub interface {
	SetRoomRecordingState(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID)
	BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string)
}

type Service struct {
	db        *db.Queries
	cfClient  CloudflareClient
	r2Client  StorageClient
	s3Client  StorageClient
	roomState RoomStateManager
	hub       WebSocketHub
}

func NewService(queries *db.Queries, cf CloudflareClient, r2 StorageClient, s3 StorageClient, roomState RoomStateManager, hub WebSocketHub) *Service {
	return &Service{
		db:        queries,
		cfClient:  cf,
		r2Client:  r2,
		s3Client:  s3,
		roomState: roomState,
		hub:       hub,
	}
}

func (s *Service) StartRecording(ctx context.Context, roomID uuid.UUID) (*db.Recording, error) {
	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return nil, ErrRoomNotFound
	}

	cfRecording, err := s.cfClient.StartRecording(ctx, room.CloudflareMeetingID, cloudflare.StartRecordingRequest{})
	if err != nil {
		return nil, fmt.Errorf("cloudflare start recording failed: %w", err)
	}

	recording, err := s.db.CreateRecording(ctx, db.CreateRecordingParams{
		RoomID:                roomID,
		CloudflareRecordingID: strPtr(cfRecording.ID),
	})
	if err != nil {
		return nil, fmt.Errorf("database insert failed: %w", err)
	}

	if s.roomState != nil {
		_ = s.roomState.SetRecordingState(ctx, roomID, true, &recording.ID)
	}

	if s.hub != nil {
		s.hub.SetRoomRecordingState(roomID, true, &recording.ID)
	}

	return &recording, nil
}

func (s *Service) StopRecording(ctx context.Context, roomID uuid.UUID) (*db.Recording, error) {
	activeRecording, err := s.db.GetActiveRecordingByRoom(ctx, roomID)
	if err != nil {
		return nil, ErrNoActiveRecording
	}

	if activeRecording.CloudflareRecordingID != nil {
		_, _ = s.cfClient.StopRecording(ctx, *activeRecording.CloudflareRecordingID)
	}

	recording, err := s.db.StopRecording(ctx, activeRecording.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to stop recording in database: %w", err)
	}

	if s.roomState != nil {
		_ = s.roomState.SetRecordingState(ctx, roomID, false, nil)
	}

	if s.hub != nil {
		s.hub.SetRoomRecordingState(roomID, false, nil)
	}

	return &recording, nil
}

func (s *Service) GetRecording(ctx context.Context, recordingID uuid.UUID) (*db.Recording, error) {
	recording, err := s.db.GetRecording(ctx, recordingID)
	if err != nil {
		return nil, ErrRecordingNotFound
	}
	return &recording, nil
}

func (s *Service) GetRecordingByCloudflareID(ctx context.Context, cloudflareRecordingID string) (*db.Recording, error) {
	recording, err := s.db.GetRecordingByCloudflareID(ctx, &cloudflareRecordingID)
	if err != nil {
		return nil, ErrRecordingNotFound
	}
	return &recording, nil
}

func (s *Service) UploadRecording(ctx context.Context, key string, reader io.Reader, contentType string) error {
	if s.r2Client == nil {
		return fmt.Errorf("R2 storage client not configured")
	}
	return s.r2Client.Upload(ctx, key, reader, contentType)
}

func (s *Service) GetRecordingWithRoomInfo(ctx context.Context, recordingID uuid.UUID) (*db.GetRecordingWithRoomInfoRow, error) {
	recording, err := s.db.GetRecordingWithRoomInfo(ctx, recordingID)
	if err != nil {
		return nil, ErrRecordingNotFound
	}
	return &recording, nil
}

func (s *Service) GetActiveRecordingByRoom(ctx context.Context, roomID uuid.UUID) (*db.Recording, error) {
	recording, err := s.db.GetActiveRecordingByRoom(ctx, roomID)
	if err != nil {
		return nil, ErrNoActiveRecording
	}
	return &recording, nil
}

func (s *Service) ListRecordingsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Recording, error) {
	recordings, err := s.db.ListRecordingsByRoom(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("failed to list recordings: %w", err)
	}
	return recordings, nil
}

func (s *Service) ListRecordingsByTenant(ctx context.Context, tenantID uuid.UUID, limit, offset int32) ([]db.ListRecordingsByTenantRow, error) {
	recordings, err := s.db.ListRecordingsByTenant(ctx, db.ListRecordingsByTenantParams{
		TenantID: tenantID,
		Limit:    limit,
		Offset:   offset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list recordings: %w", err)
	}
	return recordings, nil
}

func (s *Service) ListRecordingsByStatus(ctx context.Context, status string, limit, offset int32) ([]db.Recording, error) {
	recordings, err := s.db.ListRecordingsByStatus(ctx, db.ListRecordingsByStatusParams{
		Status: status,
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list recordings: %w", err)
	}
	return recordings, nil
}

func (s *Service) GetDownloadURL(ctx context.Context, recordingID uuid.UUID, actorID, ipAddress string) (string, error) {
	recording, err := s.db.GetRecording(ctx, recordingID)
	if err != nil {
		return "", ErrRecordingNotFound
	}

	if recording.Status != "ready" {
		return "", ErrRecordingNotReady
	}

	if recording.StoragePath == nil {
		return "", ErrRecordingNotReady
	}

	// Create audit log for GDPR compliance
	if actorID != "" {
		ip, _ := netip.ParseAddr(ipAddress)
		metadata := []byte(fmt.Sprintf(`{"size_bytes":%d,"duration_seconds":%d}`,
			ptrInt64(recording.SizeBytes), ptrInt32(recording.DurationSeconds)))
		_, _ = s.db.CreateAuditLog(ctx, db.CreateAuditLogParams{
			RoomID:       pgtype.UUID{Bytes: recording.RoomID, Valid: true},
			ActorID:      &actorID,
			Action:       "recording.downloaded",
			ResourceType: strPtr("recording"),
			ResourceID:   pgtype.UUID{Bytes: recordingID, Valid: true},
			Metadata:     metadata,
			IpAddress:    &ip,
		})
	}

	if s.r2Client != nil {
		return s.r2Client.GetPresignedURL(ctx, *recording.StoragePath, time.Hour)
	}

	return "", fmt.Errorf("no storage client configured")
}

func (s *Service) CompleteRecording(ctx context.Context, recordingID uuid.UUID, storageProvider, storagePath string, sizeBytes int64, durationSeconds int32) (*db.Recording, error) {
	recording, err := s.db.CompleteRecording(ctx, db.CompleteRecordingParams{
		ID:              recordingID,
		StorageProvider: strPtr(storageProvider),
		StoragePath:     strPtr(storagePath),
		SizeBytes:       &sizeBytes,
		DurationSeconds: &durationSeconds,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to complete recording: %w", err)
	}
	return &recording, nil
}

var (
	ErrNotReadyForArchive = errors.New("recording must be ready and stored in R2")
	ErrStoragePathMissing = errors.New("recording storage path not set")
)

func (s *Service) ArchiveRecording(ctx context.Context, recordingID uuid.UUID) (*db.Recording, error) {
	recording, err := s.db.GetRecording(ctx, recordingID)
	if err != nil {
		return nil, ErrRecordingNotFound
	}

	if recording.Status != "ready" || recording.StorageProvider == nil || *recording.StorageProvider != "r2" {
		return nil, ErrNotReadyForArchive
	}

	if recording.StoragePath == nil {
		return nil, ErrStoragePathMissing
	}

	if s.r2Client == nil || s.s3Client == nil {
		return nil, fmt.Errorf("storage clients not configured")
	}

	reader, err := s.r2Client.Download(ctx, *recording.StoragePath)
	if err != nil {
		return nil, fmt.Errorf("failed to download recording from R2: %w", err)
	}
	defer reader.Close()

	if err := s.s3Client.Upload(ctx, *recording.StoragePath, reader, "video/webm"); err != nil {
		return nil, fmt.Errorf("failed to upload recording to S3: %w", err)
	}

	archived, err := s.db.ArchiveRecording(ctx, recordingID)
	if err != nil {
		return nil, fmt.Errorf("failed to archive recording in database: %w", err)
	}

	return &archived, nil
}

func (s *Service) DeleteRecording(ctx context.Context, recordingID uuid.UUID) error {
	recording, err := s.db.GetRecording(ctx, recordingID)
	if err != nil {
		return ErrRecordingNotFound
	}

	if recording.StoragePath != nil && recording.StorageProvider != nil {
		var storageClient StorageClient
		switch *recording.StorageProvider {
		case "r2":
			storageClient = s.r2Client
		case "s3_glacier":
			storageClient = s.s3Client
		}
		if storageClient != nil {
			_ = storageClient.Delete(ctx, *recording.StoragePath)
		}
	}

	err = s.db.DeleteRecording(ctx, recordingID)
	if err != nil {
		return fmt.Errorf("failed to delete recording: %w", err)
	}
	return nil
}

func (s *Service) ListRecordingsReadyForArchive(ctx context.Context, limit int32) ([]db.Recording, error) {
	recordings, err := s.db.ListRecordingsReadyForArchive(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to list recordings: %w", err)
	}
	return recordings, nil
}

func (s *Service) GetTotalStorageByTenant(ctx context.Context, tenantID uuid.UUID) (int64, error) {
	total, err := s.db.GetTotalRecordingStorageByTenant(ctx, tenantID)
	if err != nil {
		return 0, fmt.Errorf("failed to get total storage: %w", err)
	}
	return total, nil
}

// RecoverRecording downloads a ready recording from Cloudflare and uploads it to R2.
// Used when the webhook was missed but the recording is ready in Cloudflare.
func (s *Service) RecoverRecording(ctx context.Context, recordingID uuid.UUID, downloadURL string, fileSize int64, durationSeconds int32) error {
	recording, err := s.db.GetRecording(ctx, recordingID)
	if err != nil {
		return fmt.Errorf("get recording: %w", err)
	}

	if recording.Status != "processing" {
		return fmt.Errorf("recording not in processing state: %s", recording.Status)
	}

	if s.r2Client == nil {
		return fmt.Errorf("R2 storage client not configured")
	}

	resp, err := s.streamDownload(ctx, downloadURL)
	if err != nil {
		return fmt.Errorf("download from cloudflare: %w", err)
	}
	defer resp.Body.Close()

	storageKey := fmt.Sprintf("recordings/%s/%s.webm", recording.RoomID, recording.ID)

	if err := s.r2Client.Upload(ctx, storageKey, resp.Body, "video/webm"); err != nil {
		return fmt.Errorf("upload to R2: %w", err)
	}

	_, err = s.CompleteRecording(ctx, recordingID, "r2", storageKey, fileSize, durationSeconds)
	if err != nil {
		return fmt.Errorf("complete recording: %w", err)
	}

	return nil
}

func (s *Service) streamDownload(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	return resp, nil
}

// SyncResult contains the result of syncing recordings from Cloudflare
type SyncResult struct {
	Synced   []db.Recording
	Existing []db.Recording
	Errors   []string
}

// SyncRecordingsFromCloudflare imports recordings from Cloudflare that don't exist in our DB.
// This handles auto-started recordings (record_on_start) that bypassed our API.
func (s *Service) SyncRecordingsFromCloudflare(ctx context.Context, roomID uuid.UUID) (*SyncResult, error) {
	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return nil, ErrRoomNotFound
	}

	cfRecordings, err := s.cfClient.ListRecordingsByMeeting(ctx, room.CloudflareMeetingID)
	if err != nil {
		return nil, fmt.Errorf("failed to list recordings from Cloudflare: %w", err)
	}

	result := &SyncResult{}

	for _, cfRec := range cfRecordings {
		existing, _ := s.db.GetRecordingByCloudflareID(ctx, &cfRec.ID)
		if existing.ID != uuid.Nil {
			result.Existing = append(result.Existing, existing)
			continue
		}

		status := "processing"
		if cfRec.Status == cloudflare.RecordingStatusCompleted {
			status = "processing" // Will be recovered separately
		} else if cfRec.Status == cloudflare.RecordingStatusFailed {
			status = "failed"
		} else if cfRec.Status == cloudflare.RecordingStatusRecording {
			status = "recording"
		}

		recording, err := s.db.CreateRecording(ctx, db.CreateRecordingParams{
			RoomID:                roomID,
			CloudflareRecordingID: &cfRec.ID,
		})
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("failed to create recording %s: %v", cfRec.ID, err))
			continue
		}

		if status != "recording" {
			recording, _ = s.db.StopRecording(ctx, recording.ID)
		}

		result.Synced = append(result.Synced, recording)
	}

	return result, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func ptrInt64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func ptrInt32(p *int32) int32 {
	if p == nil {
		return 0
	}
	return *p
}
