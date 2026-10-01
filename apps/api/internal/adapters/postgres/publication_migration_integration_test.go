package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestPublicationMigrationBoundsWriterContentionAndNotifiesOnlyOnCommit(t *testing.T) {
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx := context.Background()
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	defer admin.Close(ctx)
	schema := "publication_lock_" + mustProviderOperationID(t).String()[:8]
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "create schema "+quoted); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "drop schema "+quoted+" cascade") }()
	connectionConfig, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	connectionConfig.RuntimeParams["search_path"] = schema
	database := stdlib.OpenDB(*connectionConfig)
	defer database.Close()
	if _, err := database.ExecContext(ctx, `create table episodes (id uuid, tenant_id uuid, space_id uuid);
 create table provider_operation_observations (tenant_id uuid, episode_id uuid)`); err != nil {
		t.Fatal(err)
	}
	filename := "20260930160000_provider_publication_notifications.sql"
	contents, err := migrations.Files.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, database, fstest.MapFS{filename: &fstest.MapFile{Data: contents}}, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}
	writer, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.ExecContext(ctx, `insert into provider_operation_observations values (null, null)`); err != nil {
		t.Fatal(err)
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	started := time.Now()
	_, err = provider.Up(timeoutCtx)
	elapsed := time.Since(started)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "55P03" {
		t.Fatalf("migration should fail on lock_timeout, elapsed=%s: %v", elapsed, err)
	}
	if elapsed < 4*time.Second || elapsed >= 8*time.Second {
		t.Fatalf("migration lock wait = %s, want about 5 seconds", elapsed)
	}
	t.Logf("contended migration failed after %s", elapsed)
	if err := writer.Rollback(); err != nil {
		t.Fatal(err)
	}
	writeCtx, writeCancel := context.WithTimeout(ctx, time.Second)
	defer writeCancel()
	if _, err := database.ExecContext(writeCtx, `insert into provider_operation_observations values (null, null)`); err != nil {
		t.Fatalf("publication writes did not resume: %v", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("migration retry: %v", err)
	}
	tenant, space, episode := mustProviderOperationID(t), mustProviderOperationID(t), mustProviderOperationID(t)
	if _, err := database.ExecContext(ctx, `insert into episodes values ($1, $2, $3)`, episode.Bytes(), tenant.Bytes(), space.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `listen chalk_media_publications`); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rolledBack.Rollback()
	if _, err := rolledBack.ExecContext(ctx, `insert into provider_operation_observations values ($1, $2)`, tenant.Bytes(), episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := rolledBack.Rollback(); err != nil {
		t.Fatal(err)
	}
	quietCtx, quietCancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer quietCancel()
	if notification, err := admin.WaitForNotification(quietCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("rolled-back insert emitted notification: %+v, %v", notification, err)
	}
	if _, err := database.ExecContext(ctx, `insert into provider_operation_observations values ($1, $2)`, tenant.Bytes(), episode.Bytes()); err != nil {
		t.Fatal(err)
	}
	notifyCtx, notifyCancel := context.WithTimeout(ctx, time.Second)
	defer notifyCancel()
	notification, err := admin.WaitForNotification(notifyCtx)
	if err != nil {
		t.Fatal(err)
	}
	want := tenant.String() + ":" + space.String() + ":" + episode.String()
	if notification.Payload != want {
		t.Fatalf("committed payload = %q, want %q", notification.Payload, want)
	}
}
