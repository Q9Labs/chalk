package recorderarchive

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

// Presign uses the controller host's temporary AWS identity, never a node credential.
func Presign(ctx context.Context, archive recorderfleet.ArchiveSpec, startupTimeout time.Duration) (string, error) {
	if err := archive.Validate(); err != nil {
		return "", err
	}
	lifetime := startupTimeout + 5*time.Minute
	if startupTimeout <= 0 || startupTimeout > 7*24*time.Hour-5*time.Minute {
		return "", recorderfleet.ErrInvalidConfig
	}
	config, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(archive.Region))
	if err != nil {
		return "", fmt.Errorf("load recorder archive signing identity: %w", err)
	}
	credentials, err := config.Credentials.Retrieve(ctx)
	if err != nil {
		return "", fmt.Errorf("load recorder archive signing credentials: %w", err)
	}
	if credentials.CanExpire && time.Until(credentials.Expires) < lifetime {
		return "", fmt.Errorf("recorder archive signing identity expires before startup deadline")
	}
	client := s3.NewPresignClient(s3.NewFromConfig(config))
	request, err := client.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(archive.Bucket), Key: aws.String(archive.Key),
	}, s3.WithPresignExpires(lifetime))
	if err != nil {
		return "", fmt.Errorf("presign recorder archive: %w", err)
	}
	return request.URL, nil
}
