package observability

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestAPIKeyQueryTelemetryReportsFailureWithoutCredentialMaterial(t *testing.T) {
	const (
		rawKey = "chalk_sk_secretprefix.secretvalue"
		hash   = "secret-hash"
		prefix = "secretprefix"
	)
	databaseErr := errors.New("duplicate value " + rawKey + " " + hash + " " + prefix)
	queries := &apiKeyOperationQueries{createErr: databaseErr}
	var output bytes.Buffer
	observed := OperationQueries(queries, slog.New(slog.NewJSONHandler(&output, nil)))

	_, err := observed.CreateAPIKey(context.Background(), sqlc.CreateAPIKeyParams{
		KeyHash: hash, KeyPrefix: prefix,
	})
	if !errors.Is(err, databaseErr) {
		t.Fatalf("error = %v, want original database error", err)
	}

	logged := output.String()
	if !strings.Contains(logged, `"name":"CreateAPIKey"`) || !strings.Contains(logged, `"outcome":"error"`) {
		t.Fatalf("log = %s", logged)
	}
	for _, secret := range []string{rawKey, hash, prefix} {
		if strings.Contains(logged, secret) {
			t.Fatalf("log contains credential material %q: %s", secret, logged)
		}
	}
}

func TestAPIKeyQueryTelemetryReportsOnlyOperationSuccess(t *testing.T) {
	queries := &apiKeyOperationQueries{}
	var output bytes.Buffer
	observed := OperationQueries(queries, slog.New(slog.NewJSONHandler(&output, nil)))

	_, err := observed.GetActiveAPIKeyByPrefix(context.Background(), "secretprefix")
	if err != nil {
		t.Fatalf("get active key: %v", err)
	}

	logged := output.String()
	for _, value := range []string{`"event":"db.query"`, `"name":"GetActiveAPIKeyByPrefix"`, `"outcome":"ok"`, `"duration_ms"`} {
		if !strings.Contains(logged, value) {
			t.Fatalf("log missing %q: %s", value, logged)
		}
	}
	if strings.Contains(logged, "secretprefix") {
		t.Fatalf("log contains key prefix: %s", logged)
	}
}

type apiKeyOperationQueries struct {
	sqlc.Querier
	createErr error
}

func (q *apiKeyOperationQueries) CreateAPIKey(context.Context, sqlc.CreateAPIKeyParams) (sqlc.CreateAPIKeyRow, error) {
	return sqlc.CreateAPIKeyRow{}, q.createErr
}

func (q *apiKeyOperationQueries) GetActiveAPIKeyByPrefix(context.Context, string) (sqlc.GetActiveAPIKeyByPrefixRow, error) {
	return sqlc.GetActiveAPIKeyByPrefixRow{}, nil
}
