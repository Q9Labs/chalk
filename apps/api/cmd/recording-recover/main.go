// recording-recover grants one audited completion attempt using operator-owned
// database and object-store credentials. It never changes the automatic cap.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	tenant := flag.String("tenant-id", "", "Tenant UUID")
	recording := flag.String("recording-id", "", "Recording UUID")
	request := flag.String("request-id", "", "stable recovery request UUID; reuse for a replay")
	operator := flag.String("operator", "", "operator identity for the audit")
	reason := flag.String("reason", "", "why completion can now succeed")
	timeout := flag.Duration("timeout", 15*time.Minute, "maximum time to inspect the retained source and queue recovery")
	flag.Parse()
	if *timeout <= 0 {
		return fmt.Errorf("timeout must be positive")
	}
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	tenantID, err := utilities.ParseID(*tenant)
	if err != nil {
		return fmt.Errorf("tenant-id: %w", err)
	}
	recordingID, err := utilities.ParseID(*recording)
	if err != nil {
		return fmt.Errorf("recording-id: %w", err)
	}
	requestID, err := utilities.ParseID(*request)
	if err != nil {
		return fmt.Errorf("request-id: %w", err)
	}
	databaseURL := os.Getenv(config.DatabaseURL)
	if databaseURL == "" {
		return fmt.Errorf("%s is required", config.DatabaseURL)
	}
	store, err := r2.NewStore(config.R2Config{AccountID: os.Getenv(config.R2AccountID), Endpoint: os.Getenv(config.R2Endpoint), Bucket: os.Getenv(config.R2Bucket), AccessKeyID: os.Getenv(config.R2AccessKeyID), SecretAccessKey: os.Getenv(config.R2SecretAccessKey), RequestTimeout: 15 * time.Second})
	if err != nil {
		return fmt.Errorf("configure Recording source store: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("open recovery database: %w", err)
	}
	defer pool.Close()
	err = postgres.NewRecordingPipelineRepositoryWithPool(pool).RequestCompletionRecovery(ctx, recordingpipeline.CompletionRecoveryInput{TenantID: tenantID, RecordingID: recordingID, RequestID: requestID, Operator: *operator, Reason: *reason}, store)
	if err != nil {
		return err
	}
	fmt.Printf("Recording completion recovery accepted request_id=%s\n", requestID.String())
	return nil
}
