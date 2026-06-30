package tenants_test

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestParseTenantID(t *testing.T) {
	id, err := tenants.ParseTenantID(" 11111111-1111-1111-1111-111111111111 ")
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	if id.String() != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("tenant id = %q, want canonical id", id.String())
	}
}

func TestParseTenantIDRejectsInvalidID(t *testing.T) {
	tests := []string{
		"",
		"not-a-uuid",
		"11111111111111111111111111111111",
		"11111111-1111-1111-1111-11111111111z",
	}

	for _, value := range tests {
		t.Run(value, func(t *testing.T) {
			_, err := tenants.ParseTenantID(value)
			if !errors.Is(err, tenants.ErrInvalidTenantID) {
				t.Fatalf("error = %v, want %v", err, tenants.ErrInvalidTenantID)
			}
		})
	}
}
