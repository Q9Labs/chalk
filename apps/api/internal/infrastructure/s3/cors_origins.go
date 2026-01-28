package s3

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// CORSOriginsService handles aggregation of tenant CORS origins and uploading to S3
type CORSOriginsService struct {
	s3Client      *s3.Client
	bucket        string
	key           string
	queries       *db.Queries
	githubRepo    string
	githubToken   string
	staticOrigins []string
	enabled       bool
	logger        *slog.Logger
}

// CORSOriginsConfig holds configuration for the CORS origins service
type CORSOriginsConfig struct {
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	Key             string // e.g., "cors/allowed-origins.json"
	GitHubRepo      string // e.g., "Q9Labs/chalk"
	GitHubToken     string // For triggering workflows
}

// CORSOriginsFile represents the JSON structure uploaded to S3
type CORSOriginsFile struct {
	Origins   []string  `json:"origins"`
	UpdatedAt time.Time `json:"updated_at"`
}

// NewCORSOriginsService creates a new CORS origins service
func NewCORSOriginsService(cfg CORSOriginsConfig, queries *db.Queries, logger *slog.Logger) (*CORSOriginsService, error) {
	if logger == nil {
		logger = slog.Default()
	}
	logger = logger.With("component", "cors_origins")

	// If no credentials provided, create a disabled service
	if cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" || cfg.Bucket == "" {
		logger.Info("CORS origins S3 service disabled (no credentials configured)")
		return &CORSOriginsService{
			enabled: false,
			queries: queries,
			logger:  logger,
		}, nil
	}

	if cfg.Region == "" {
		cfg.Region = "me-central-1"
	}
	if cfg.Key == "" {
		cfg.Key = "cors/allowed-origins.json"
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(cfg.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID,
			cfg.SecretAccessKey,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg)

	return &CORSOriginsService{
		s3Client:    client,
		bucket:      cfg.Bucket,
		key:         cfg.Key,
		queries:     queries,
		githubRepo:  cfg.GitHubRepo,
		githubToken: cfg.GitHubToken,
		staticOrigins: []string{
			"https://chalk.q9labs.ai",
			"https://chalk-5bc.pages.dev",
			"https://collabdash-dev.vercel.app",
			"https://app.collabdash.io",
			"https://dev.dwd4jsk5p7j52.amplifyapp.com",
			"https://portal-dev.tuitionhighway.com",
			"https://portal.tuitionhighway.com",
			"https://backend.tuitionhighway.com",
			"https://backend-dev.tuitionhighway.com",
		},
		enabled: true,
		logger:  logger,
	}, nil
}

// AggregateAndUpload fetches all tenant origins + static origins and uploads to S3
func (s *CORSOriginsService) AggregateAndUpload(ctx context.Context) error {
	if !s.enabled {
		s.logger.Debug("CORS origins S3 upload skipped (service disabled)")
		return nil
	}

	// Get all tenant origins from database
	tenantOrigins, err := s.queries.GetAllTenantAllowedOrigins(ctx)
	if err != nil {
		return fmt.Errorf("failed to get tenant origins: %w", err)
	}

	// Combine static + tenant origins (deduplicated)
	originSet := make(map[string]struct{})
	for _, o := range s.staticOrigins {
		originSet[o] = struct{}{}
	}
	for _, o := range tenantOrigins {
		originSet[o] = struct{}{}
	}

	// Convert to slice
	origins := make([]string, 0, len(originSet))
	for o := range originSet {
		origins = append(origins, o)
	}

	// Create JSON file
	file := CORSOriginsFile{
		Origins:   origins,
		UpdatedAt: time.Now().UTC(),
	}

	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal origins: %w", err)
	}

	// Upload to S3
	_, err = s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(s.key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}

	s.logger.Info("CORS origins uploaded",
		"bucket", s.bucket,
		"key", s.key,
		"origin_count", len(origins),
	)

	// Trigger GitHub workflow for Terraform sync
	if s.githubToken != "" && s.githubRepo != "" {
		if err := s.triggerGitHubWorkflow(ctx); err != nil {
			// Log but don't fail - S3 upload succeeded
			s.logger.Warn("failed to trigger GitHub workflow", "error", err)
		}
	}

	return nil
}

// triggerGitHubWorkflow triggers the CORS sync workflow via repository_dispatch
func (s *CORSOriginsService) triggerGitHubWorkflow(ctx context.Context) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/dispatches", s.githubRepo)

	payload := map[string]string{
		"event_type": "cors-origins-updated",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+s.githubToken)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to trigger workflow: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	s.logger.Info("triggered GitHub workflow", "repo", s.githubRepo)
	return nil
}

// IsEnabled returns whether the service is enabled
func (s *CORSOriginsService) IsEnabled() bool {
	return s.enabled
}
