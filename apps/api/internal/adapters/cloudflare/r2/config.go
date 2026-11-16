package r2

import (
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"net/http"
	"strings"
)

func NewStore(cfg config.R2Config) (Store, error) {
	bucket := strings.TrimSpace(cfg.Bucket)
	accountID := strings.TrimSpace(cfg.AccountID)
	customEndpoint := strings.TrimSpace(cfg.Endpoint)
	accessKeyID := strings.TrimSpace(cfg.AccessKeyID)
	secretAccessKey := strings.TrimSpace(cfg.SecretAccessKey)
	if bucket == "" || (accountID == "" && customEndpoint == "") || accessKeyID == "" || secretAccessKey == "" || cfg.RequestTimeout <= 0 {
		return Store{}, ErrMissingConfig
	}

	awsConfig := aws.Config{
		Credentials: credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, ""),
		HTTPClient:  &http.Client{Timeout: cfg.RequestTimeout},
		Region:      region,
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint(cfg))
		options.UsePathStyle = true
	})

	objects := client
	if internalEndpoint := strings.TrimSpace(cfg.InternalEndpoint); internalEndpoint != "" {
		objects = s3.NewFromConfig(awsConfig, func(options *s3.Options) {
			options.BaseEndpoint = aws.String(internalEndpoint)
			options.UsePathStyle = true
		})
	}
	return newStore(bucket, objects, s3.NewPresignClient(client)), nil
}
