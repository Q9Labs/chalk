package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/rooms"
)

type fakeBootstrapDatabase struct {
	transaction *fakeBootstrapTransaction
}

func (d *fakeBootstrapDatabase) BeginBootstrap(context.Context) (bootstrapTransaction, error) {
	return d.transaction, nil
}

func (d *fakeBootstrapDatabase) Close() {}

func TestExecuteRequiresExplicitNonLocalConfirmation(t *testing.T) {
	opened := false
	err := execute(context.Background(), []string{"--owner-user-id", bootstrapTestOwnerID.String()}, func(key string) string {
		switch key {
		case "CHALK_API_ENV":
			return "production"
		case "CHALK_DATABASE_URL":
			return "postgres://sensitive.example/chalk"
		default:
			return ""
		}
	}, &bytes.Buffer{}, func(context.Context, string) (bootstrapDatabase, error) {
		opened = true
		return nil, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || err.Error() != "--confirm-non-local is required when CHALK_API_ENV=production" {
		t.Fatalf("confirmation error = %v", err)
	}
	if opened {
		t.Fatal("database opened without non-local confirmation")
	}
}

func TestExecuteRequiresExplicitEnvironment(t *testing.T) {
	opened := false
	err := execute(context.Background(), []string{"--owner-user-id", bootstrapTestOwnerID.String()}, func(key string) string {
		if key == "CHALK_DATABASE_URL" {
			return "postgres://sensitive.example/chalk"
		}
		return ""
	}, &bytes.Buffer{}, func(context.Context, string) (bootstrapDatabase, error) {
		opened = true
		return nil, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || err.Error() != "CHALK_API_ENV is required" {
		t.Fatalf("environment error = %v", err)
	}
	if opened {
		t.Fatal("database opened without an explicit environment")
	}
}

func TestExecuteRejectsNonLocalDatabaseWithoutTLS(t *testing.T) {
	opened := false
	err := execute(context.Background(), []string{"--confirm-non-local", "--owner-user-id", bootstrapTestOwnerID.String()}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "production"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://operator:secret@sensitive.example/chalk?sslmode=disable"
		}
		return ""
	}, &bytes.Buffer{}, func(context.Context, string) (bootstrapDatabase, error) {
		opened = true
		return nil, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || !strings.Contains(err.Error(), "sslmode=require") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("TLS error = %v", err)
	}
	if opened {
		t.Fatal("database opened without non-local TLS")
	}
}

func TestExecuteCommitsAndWritesMachineReadableResult(t *testing.T) {
	transaction := &fakeBootstrapTransaction{ownerExists: true}
	database := &fakeBootstrapDatabase{transaction: transaction}
	var output bytes.Buffer
	err := execute(context.Background(), []string{
		"--confirm-non-local",
		"--owner-user-id", bootstrapTestOwnerID.String(),
		"--result-file", filepath.Join(t.TempDir(), "bootstrap.json"),
	}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "production"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://sensitive.example/chalk?sslmode=verify-full"
		}
		return ""
	}, &output, func(_ context.Context, databaseURL string) (bootstrapDatabase, error) {
		if databaseURL != "postgres://sensitive.example/chalk?sslmode=verify-full" {
			t.Fatalf("database url = %q", databaseURL)
		}
		return database, nil
	}, func() time.Time { return bootstrapTestNow })
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !transaction.committed || !transaction.rolledBack {
		t.Fatalf("transaction commit/cleanup = %v/%v", transaction.committed, transaction.rolledBack)
	}
	text := output.String()
	if !strings.Contains(text, `"tenant_id":"`+bootstrapTestTenantID.String()+`"`) || !strings.Contains(text, `"api_key_secret":"chalk_sk_test.once"`) {
		t.Fatalf("output = %s", text)
	}
}

func TestExecutePreservesCommittedResultWhenStandardOutputFails(t *testing.T) {
	transaction := &fakeBootstrapTransaction{ownerExists: true}
	resultFile := filepath.Join(t.TempDir(), "bootstrap.json")
	err := execute(context.Background(), []string{
		"--owner-user-id", bootstrapTestOwnerID.String(),
		"--result-file", resultFile,
	}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "local"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://local/chalk?sslmode=disable"
		}
		return ""
	}, errorWriter{}, func(context.Context, string) (bootstrapDatabase, error) {
		return &fakeBootstrapDatabase{transaction: transaction}, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || err.Error() != "write bootstrap result failed" {
		t.Fatalf("output error = %v", err)
	}
	if !transaction.committed {
		t.Fatal("transaction was not committed")
	}
	artifact, readErr := os.ReadFile(resultFile)
	if readErr != nil {
		t.Fatalf("read preserved result: %v", readErr)
	}
	if !strings.Contains(string(artifact), `"api_key_secret":"chalk_sk_test.once"`) {
		t.Fatalf("preserved result = %s", artifact)
	}
}

func TestExecuteRemovesResultWhenCommitFails(t *testing.T) {
	transaction := &fakeBootstrapTransaction{ownerExists: true, commitErr: errors.New("commit failed")}
	resultFile := filepath.Join(t.TempDir(), "bootstrap.json")
	err := execute(context.Background(), []string{
		"--owner-user-id", bootstrapTestOwnerID.String(),
		"--result-file", resultFile,
	}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "local"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://local/chalk?sslmode=disable"
		}
		return ""
	}, &bytes.Buffer{}, func(context.Context, string) (bootstrapDatabase, error) {
		return &fakeBootstrapDatabase{transaction: transaction}, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || err.Error() != "commit failed" {
		t.Fatalf("commit error = %v", err)
	}
	if _, statErr := os.Stat(resultFile); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("result file remained after failed commit: %v", statErr)
	}
}

func TestExecuteNormalizesIdentityFlags(t *testing.T) {
	transaction := &fakeBootstrapTransaction{ownerExists: true}
	err := execute(context.Background(), []string{
		"--owner-user-id", bootstrapTestOwnerID.String(),
		"--result-file", filepath.Join(t.TempDir(), "bootstrap.json"),
		"--tenant-name", "  Custom tenant  ",
		"--room-name", "  Custom room  ",
		"--room-slug", "  custom-room  ",
		"--api-key-name", "  custom-key  ",
	}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "local"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://local/chalk?sslmode=disable"
		}
		return ""
	}, &bytes.Buffer{}, func(context.Context, string) (bootstrapDatabase, error) {
		return &fakeBootstrapDatabase{transaction: transaction}, nil
	}, func() time.Time { return bootstrapTestNow })
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if transaction.createdTenantInput.Name != "Custom tenant" || transaction.createdRoomInput.Name != "Custom room" || transaction.createdRoomInput.Slug != "custom-room" || transaction.createdKeyInput.Name != "custom-key" {
		t.Fatalf("normalized resources = %q / %q / %q / %q", transaction.createdTenantInput.Name, transaction.createdRoomInput.Name, transaction.createdRoomInput.Slug, transaction.createdKeyInput.Name)
	}
}

func TestExecuteRollsBackAndEmitsNothingOnProvisionFailure(t *testing.T) {
	transaction := &fakeBootstrapTransaction{
		ownerExists: true,
		roomFound:   true,
		room: rooms.Room{
			ID: bootstrapTestRoomID, Name: defaultRoomName, Status: "archived", Slug: defaultRoomSlug, MediaPlane: cloudflareSFU,
		},
	}
	database := &fakeBootstrapDatabase{transaction: transaction}
	var output bytes.Buffer
	err := execute(context.Background(), []string{
		"--owner-user-id", bootstrapTestOwnerID.String(),
		"--result-file", filepath.Join(t.TempDir(), "bootstrap.json"),
	}, func(key string) string {
		if key == "CHALK_API_ENV" {
			return "local"
		}
		if key == "CHALK_DATABASE_URL" {
			return "postgres://sensitive.example/chalk"
		}
		return ""
	}, &output, func(context.Context, string) (bootstrapDatabase, error) {
		return database, nil
	}, func() time.Time { return bootstrapTestNow })
	if err == nil || err.Error() != "bootstrap room slug is already used by an incompatible room" {
		t.Fatalf("provision error = %v", err)
	}
	if transaction.createdKeyInput.TenantID.IsZero() {
		t.Fatal("failure did not occur after generating the one-time credential")
	}
	if transaction.committed || !transaction.rolledBack {
		t.Fatalf("transaction commit/rollback = %v/%v", transaction.committed, transaction.rolledBack)
	}
	if output.Len() != 0 {
		t.Fatalf("failed bootstrap emitted output: %q", output.String())
	}
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) {
	return 0, errors.New("output failed")
}
