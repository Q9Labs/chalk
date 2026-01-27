package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

// MockR2Client is a mock implementation of StorageClient for testing
type MockR2Client struct {
	mu      sync.RWMutex
	files   map[string][]byte
	deleted map[string]bool
}

func NewMockR2Client() *MockR2Client {
	return &MockR2Client{
		files:   make(map[string][]byte),
		deleted: make(map[string]bool),
	}
}

func (m *MockR2Client) Upload(ctx context.Context, key string, body io.Reader, contentType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	m.files[key] = data
	delete(m.deleted, key)
	return nil
}

func (m *MockR2Client) Download(ctx context.Context, key string) (io.ReadCloser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.files[key]
	if !ok {
		return nil, fmt.Errorf("file not found: %s", key)
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (m *MockR2Client) GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	return fmt.Sprintf("https://mock.storage/%s?expires=%d", key, expiry.Milliseconds()), nil
}

func (m *MockR2Client) Delete(ctx context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.files, key)
	m.deleted[key] = true
	return nil
}

func (m *MockR2Client) Exists(ctx context.Context, key string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, exists := m.files[key]
	return exists, nil
}

func (m *MockR2Client) ListByPrefix(ctx context.Context, prefix string) ([]StorageObject, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var objects []StorageObject
	for key := range m.files {
		if strings.HasPrefix(key, prefix) {
			objects = append(objects, StorageObject{Key: key, Size: int64(len(m.files[key]))})
		}
	}
	return objects, nil
}

type MockRecordingArchiver struct {
	recordings    []db.Recording
	archivedCalls []db.ArchiveRecordingWithPathParams
}

func NewMockRecordingArchiver() *MockRecordingArchiver {
	return &MockRecordingArchiver{
		recordings:    make([]db.Recording, 0),
		archivedCalls: make([]db.ArchiveRecordingWithPathParams, 0),
	}
}

func (m *MockRecordingArchiver) ListRecordingsReadyForArchive(ctx context.Context, limit int32) ([]db.Recording, error) {
	return m.recordings, nil
}

func (m *MockRecordingArchiver) ArchiveRecordingWithPath(ctx context.Context, arg db.ArchiveRecordingWithPathParams) (db.Recording, error) {
	m.archivedCalls = append(m.archivedCalls, arg)
	for i, rec := range m.recordings {
		if rec.ID == arg.ID {
			m.recordings[i].Status = "archived"
			m.recordings[i].StoragePath = arg.StoragePath
			provider := "s3_glacier"
			m.recordings[i].StorageProvider = &provider
			return m.recordings[i], nil
		}
	}
	return db.Recording{}, nil
}

func TestDefaultLifecycleConfig(t *testing.T) {
	cfg := DefaultLifecycleConfig()

	assert.Equal(t, 24*time.Hour, cfg.Interval)
	assert.Equal(t, 7*24*time.Hour, cfg.ArchiveAge)
	assert.Equal(t, int32(100), cfg.BatchSize)
}

func TestNewRecordingLifecycleManager(t *testing.T) {
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	cfg := LifecycleConfig{
		Interval:   1 * time.Hour,
		ArchiveAge: 3 * 24 * time.Hour,
		BatchSize:  50,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, cfg)

	assert.NotNil(t, mgr)
	assert.Equal(t, 1*time.Hour, mgr.interval)
	assert.Equal(t, 3*24*time.Hour, mgr.archiveAge)
	assert.Equal(t, int32(50), mgr.batchSize)
}

func TestNewRecordingLifecycleManager_DefaultConfig(t *testing.T) {
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, LifecycleConfig{})

	assert.Equal(t, 24*time.Hour, mgr.interval)
	assert.Equal(t, 7*24*time.Hour, mgr.archiveAge)
	assert.Equal(t, int32(100), mgr.batchSize)
}

func TestLifecycleManager_ArchiveRecording_Success(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath := "recordings/room1/rec1.webm"
	provider := "r2"
	recID := uuid.New()

	_ = r2.Upload(ctx, storagePath, strings.NewReader("video data"), "video/webm")

	rec := db.Recording{
		ID:              recID,
		RoomID:          uuid.New(),
		Status:          "ready",
		StoragePath:     &storagePath,
		StorageProvider: &provider,
		StartedAt:       pgtype.Timestamptz{Time: time.Now().Add(-10 * 24 * time.Hour), Valid: true},
		EndedAt:         pgtype.Timestamptz{Time: time.Now().Add(-8 * 24 * time.Hour), Valid: true},
		CreatedAt:       time.Now().Add(-10 * 24 * time.Hour),
	}

	mockDB.recordings = append(mockDB.recordings, rec)

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.NoError(t, err)

	exists, _ := s3.Exists(ctx, "archive/"+storagePath)
	assert.True(t, exists, "File should exist in S3 after archiving")

	existsR2, _ := r2.Exists(ctx, storagePath)
	assert.False(t, existsR2, "File should be deleted from R2 after archiving")

	assert.Len(t, mockDB.archivedCalls, 1)
	assert.Equal(t, recID, mockDB.archivedCalls[0].ID)
	assert.Equal(t, "archive/"+storagePath, *mockDB.archivedCalls[0].StoragePath)
}

func TestLifecycleManager_ArchiveRecording_NoStoragePath(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	rec := db.Recording{
		ID:          uuid.New(),
		RoomID:      uuid.New(),
		Status:      "ready",
		StoragePath: nil,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no storage path")
}

func TestLifecycleManager_ArchiveRecording_EmptyStoragePath(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	emptyPath := ""
	provider := "r2"
	rec := db.Recording{
		ID:              uuid.New(),
		RoomID:          uuid.New(),
		Status:          "ready",
		StoragePath:     &emptyPath,
		StorageProvider: &provider,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "no storage path")
}

func TestLifecycleManager_ArchiveRecording_NotR2Provider(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath := "recordings/room1/rec1.webm"
	provider := "s3_glacier"

	rec := db.Recording{
		ID:              uuid.New(),
		RoomID:          uuid.New(),
		Status:          "ready",
		StoragePath:     &storagePath,
		StorageProvider: &provider,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "not stored in R2")
}

func TestLifecycleManager_ArchiveRecording_NilProvider(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath := "recordings/room1/rec1.webm"

	rec := db.Recording{
		ID:              uuid.New(),
		RoomID:          uuid.New(),
		Status:          "ready",
		StoragePath:     &storagePath,
		StorageProvider: nil,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "not stored in R2")
}

func TestLifecycleManager_ArchiveRecording_R2DownloadFails(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath := "recordings/room1/nonexistent.webm"
	provider := "r2"

	rec := db.Recording{
		ID:              uuid.New(),
		RoomID:          uuid.New(),
		Status:          "ready",
		StoragePath:     &storagePath,
		StorageProvider: &provider,
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveRecording(ctx, rec)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "download from R2 failed")
}

func TestLifecycleManager_ArchiveOldRecordings_Success(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath1 := "recordings/room1/rec1.webm"
	storagePath2 := "recordings/room1/rec2.webm"
	provider := "r2"

	_ = r2.Upload(ctx, storagePath1, strings.NewReader("video1"), "video/webm")
	_ = r2.Upload(ctx, storagePath2, strings.NewReader("video2"), "video/webm")

	mockDB.recordings = []db.Recording{
		{
			ID:              uuid.New(),
			RoomID:          uuid.New(),
			Status:          "ready",
			StoragePath:     &storagePath1,
			StorageProvider: &provider,
		},
		{
			ID:              uuid.New(),
			RoomID:          uuid.New(),
			Status:          "ready",
			StoragePath:     &storagePath2,
			StorageProvider: &provider,
		},
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveOldRecordings(ctx)

	require.NoError(t, err)
	assert.Len(t, mockDB.archivedCalls, 2)
}

func TestLifecycleManager_ArchiveOldRecordings_PartialFailure(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	storagePath1 := "recordings/room1/rec1.webm"
	storagePath2 := "recordings/room1/nonexistent.webm"
	provider := "r2"

	_ = r2.Upload(ctx, storagePath1, strings.NewReader("video1"), "video/webm")

	mockDB.recordings = []db.Recording{
		{
			ID:              uuid.New(),
			RoomID:          uuid.New(),
			Status:          "ready",
			StoragePath:     &storagePath1,
			StorageProvider: &provider,
		},
		{
			ID:              uuid.New(),
			RoomID:          uuid.New(),
			Status:          "ready",
			StoragePath:     &storagePath2,
			StorageProvider: &provider,
		},
	}

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveOldRecordings(ctx)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to archive 1 recordings")
	assert.Len(t, mockDB.archivedCalls, 1)
}

func TestLifecycleManager_ArchiveOldRecordings_NoRecordings(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.archiveOldRecordings(ctx)

	require.NoError(t, err)
	assert.Len(t, mockDB.archivedCalls, 0)
}

func TestLifecycleManager_Start_ContextCancellation(t *testing.T) {
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, LifecycleConfig{
		Interval:   100 * time.Millisecond,
		ArchiveAge: 7 * 24 * time.Hour,
		BatchSize:  100,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan struct{})
	go func() {
		mgr.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Start did not exit after context cancellation")
	}
}

func TestLifecycleManager_RunOnce(t *testing.T) {
	ctx := context.Background()
	r2 := NewMockR2Client()
	s3 := NewMockR2Client()
	mockDB := NewMockRecordingArchiver()

	mgr := NewRecordingLifecycleManager(r2, s3, mockDB, DefaultLifecycleConfig())

	err := mgr.RunOnce(ctx)

	require.NoError(t, err)
}

func TestRecordingArchiverInterface(t *testing.T) {
	var _ RecordingArchiver = NewMockRecordingArchiver()
}
