package storage

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestS3Config_Validation(t *testing.T) {
	testCases := []struct {
		name    string
		config  S3Config
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid config",
			config: S3Config{
				Region:          "us-east-1",
				AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
				SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				BucketName:      "my-bucket",
			},
			wantErr: false,
		},
		{
			name: "missing access key",
			config: S3Config{
				Region:          "us-east-1",
				SecretAccessKey: "secret",
				BucketName:      "my-bucket",
			},
			wantErr: true,
			errMsg:  "S3 credentials not configured",
		},
		{
			name: "missing secret key",
			config: S3Config{
				Region:      "us-east-1",
				AccessKeyID: "access",
				BucketName:  "my-bucket",
			},
			wantErr: true,
			errMsg:  "S3 credentials not configured",
		},
		{
			name: "missing bucket name",
			config: S3Config{
				Region:          "us-east-1",
				AccessKeyID:     "access",
				SecretAccessKey: "secret",
			},
			wantErr: true,
			errMsg:  "S3 bucket name is required",
		},
		{
			name: "empty credentials",
			config: S3Config{
				Region:          "us-east-1",
				AccessKeyID:     "",
				SecretAccessKey: "",
				BucketName:      "my-bucket",
			},
			wantErr: true,
			errMsg:  "S3 credentials not configured",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewS3Client(tc.config)
			if tc.wantErr {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), tc.errMsg)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestS3Config_DefaultRegion(t *testing.T) {
	config := S3Config{
		AccessKeyID:     "access",
		SecretAccessKey: "secret",
		BucketName:      "my-bucket",
		// Region is empty
	}

	client, err := NewS3Client(config)
	assert.NoError(t, err)
	assert.NotNil(t, client)
	assert.Equal(t, "us-east-1", client.region)
}

func TestS3Config_CustomRegion(t *testing.T) {
	config := S3Config{
		Region:          "eu-west-1",
		AccessKeyID:     "access",
		SecretAccessKey: "secret",
		BucketName:      "my-bucket",
	}

	client, err := NewS3Client(config)
	assert.NoError(t, err)
	assert.NotNil(t, client)
	assert.Equal(t, "eu-west-1", client.region)
}

func TestS3Client_BucketName(t *testing.T) {
	config := S3Config{
		Region:          "us-east-1",
		AccessKeyID:     "access",
		SecretAccessKey: "secret",
		BucketName:      "test-bucket",
	}

	client, err := NewS3Client(config)
	assert.NoError(t, err)
	assert.Equal(t, "test-bucket", client.bucket)
}

func TestStorageObject_Structure(t *testing.T) {
	now := time.Now()
	obj := StorageObject{
		Key:          "recordings/room-123/recording.webm",
		Size:         1024000,
		LastModified: now,
		ContentType:  "video/webm",
	}

	assert.Equal(t, "recordings/room-123/recording.webm", obj.Key)
	assert.Equal(t, int64(1024000), obj.Size)
	assert.Equal(t, now, obj.LastModified)
	assert.Equal(t, "video/webm", obj.ContentType)
}

func TestStorageClient_Interface(t *testing.T) {
	// Verify that S3Client implements StorageClient
	config := S3Config{
		Region:          "us-east-1",
		AccessKeyID:     "access",
		SecretAccessKey: "secret",
		BucketName:      "test-bucket",
	}

	client, err := NewS3Client(config)
	assert.NoError(t, err)

	// This ensures S3Client satisfies the StorageClient interface at compile time
	var _ StorageClient = client
}
