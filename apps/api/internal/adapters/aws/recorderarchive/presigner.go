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
func Presign(ctx context.Context, archive recorderfleet.ArchiveSpec) (string, error) {
	if err := archive.Validate(); err != nil {
		return "", err
	}
	config, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(archive.Region))
	if err != nil {
		return "", fmt.Errorf("load recorder archive signing identity: %w", err)
	}
	client := s3.NewPresignClient(s3.NewFromConfig(config))
	request, err := client.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(archive.Bucket), Key: aws.String(archive.Key),
	}, s3.WithPresignExpires(10*time.Minute))
	if err != nil {
		return "", fmt.Errorf("presign recorder archive: %w", err)
	}
	return request.URL, nil
}
