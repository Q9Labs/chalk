package postgres

import (
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

func accountTenantIntegrationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
