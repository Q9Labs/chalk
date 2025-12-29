package storage

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// MockR2Client is a mock implementation for testing
type MockR2Client struct {
	files map[string][]byte
}

func NewMockR2Client() *MockR2Client {
	return &MockR2Client{
		files: make(map[string][]byte),
	}
}

func (m *MockR2Client) Upload(ctx context.Context, key string, body io.Reader, contentType string) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	m.files[key] = data
	return nil
}

func (m *MockR2Client) Download(ctx context.Context, key string) (io.ReadCloser, error) {
	data, ok := m.files[key]
	if !ok {
		return nil, io.ErrUnexpectedEOF
	}
	return io.NopCloser(strings.NewReader(string(data))), nil
}

func (m *MockR2Client) GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	if _, ok := m.files[key]; !ok {
		return "", io.ErrUnexpectedEOF
	}
	return "https://example.com/" + key + "?X-Amz-Signature=mock", nil
}

func (m *MockR2Client) GetPresignedUploadURL(ctx context.Context, key, contentType string, expiry time.Duration) (string, error) {
	return "https://example.com/upload/" + key + "?X-Amz-Signature=mock", nil
}

func (m *MockR2Client) Delete(ctx context.Context, key string) error {
	delete(m.files, key)
	return nil
}

func (m *MockR2Client) Exists(ctx context.Context, key string) (bool, error) {
	_, ok := m.files[key]
	return ok, nil
}

func (m *MockR2Client) ListByPrefix(ctx context.Context, prefix string) ([]StorageObject, error) {
	var objects []StorageObject
	for key := range m.files {
		if strings.HasPrefix(key, prefix) {
			objects = append(objects, StorageObject{
				Key:  key,
				Size: int64(len(m.files[key])),
			})
		}
	}
	return objects, nil
}

// Test interface compliance
func TestR2ClientImplementsStorageClient(t *testing.T) {
	var _ StorageClient = NewMockR2Client()
}

func TestMockR2Client_Upload(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	data := "test video data"
	err := client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader(data), "video/webm")
	require.NoError(t, err)

	assert.Equal(t, data, string(client.files["recordings/room1/rec1.webm"]))
}

func TestMockR2Client_Download(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	// Upload first
	data := "test video data"
	_ = client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader(data), "video/webm")

	// Download
	reader, err := client.Download(ctx, "recordings/room1/rec1.webm")
	require.NoError(t, err)
	defer reader.Close()

	downloaded, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, data, string(downloaded))
}

func TestMockR2Client_GetPresignedURL(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	data := "test video data"
	_ = client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader(data), "video/webm")

	url, err := client.GetPresignedURL(ctx, "recordings/room1/rec1.webm", 1*time.Hour)
	require.NoError(t, err)
	assert.NotEmpty(t, url)
	assert.Contains(t, url, "recordings/room1/rec1.webm")
	assert.Contains(t, url, "X-Amz-Signature")
}

func TestMockR2Client_GetPresignedURL_NotFound(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	_, err := client.GetPresignedURL(ctx, "nonexistent", 1*time.Hour)
	require.Error(t, err)
}

func TestMockR2Client_GetPresignedUploadURL(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	url, err := client.GetPresignedUploadURL(ctx, "recordings/room1/rec1.webm", "video/webm", 1*time.Hour)
	require.NoError(t, err)
	assert.NotEmpty(t, url)
	assert.Contains(t, url, "recordings/room1/rec1.webm")
	assert.Contains(t, url, "X-Amz-Signature")
}

func TestMockR2Client_Delete(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	// Upload first
	data := "test video data"
	_ = client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader(data), "video/webm")

	// Verify exists
	exists, err := client.Exists(ctx, "recordings/room1/rec1.webm")
	require.NoError(t, err)
	assert.True(t, exists)

	// Delete
	err = client.Delete(ctx, "recordings/room1/rec1.webm")
	require.NoError(t, err)

	// Verify deleted
	exists, err = client.Exists(ctx, "recordings/room1/rec1.webm")
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestMockR2Client_Exists(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	// Non-existent file
	exists, err := client.Exists(ctx, "nonexistent")
	require.NoError(t, err)
	assert.False(t, exists)

	// Upload file
	data := "test video data"
	_ = client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader(data), "video/webm")

	// Existing file
	exists, err = client.Exists(ctx, "recordings/room1/rec1.webm")
	require.NoError(t, err)
	assert.True(t, exists)
}

func TestMockR2Client_ListByPrefix(t *testing.T) {
	client := NewMockR2Client()
	ctx := context.Background()

	// Upload multiple files
	_ = client.Upload(ctx, "recordings/room1/rec1.webm", strings.NewReader("data1"), "video/webm")
	_ = client.Upload(ctx, "recordings/room1/rec2.webm", strings.NewReader("data2"), "video/webm")
	_ = client.Upload(ctx, "recordings/room2/rec3.webm", strings.NewReader("data3"), "video/webm")
	_ = client.Upload(ctx, "thumbnails/room1/thumb.jpg", strings.NewReader("thumb"), "image/jpeg")

	// List by prefix
	objects, err := client.ListByPrefix(ctx, "recordings/room1/")
	require.NoError(t, err)
	assert.Len(t, objects, 2)

	// Verify keys
	keys := make(map[string]bool)
	for _, obj := range objects {
		keys[obj.Key] = true
	}
	assert.True(t, keys["recordings/room1/rec1.webm"])
	assert.True(t, keys["recordings/room1/rec2.webm"])
}
