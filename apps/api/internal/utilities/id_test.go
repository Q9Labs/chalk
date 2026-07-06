package utilities_test

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestParseID(t *testing.T) {
	id, err := utilities.ParseID(" 11111111-1111-1111-1111-111111111111 ")
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}

	if id.String() != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("id = %q, want canonical id", id.String())
	}
}

func TestParseIDRejectsInvalidID(t *testing.T) {
	tests := []string{
		"",
		"not-a-uuid",
		"11111111111111111111111111111111",
		"11111111-1111-1111-1111-11111111111z",
	}

	for _, value := range tests {
		t.Run(value, func(t *testing.T) {
			_, err := utilities.ParseID(value)
			if !errors.Is(err, utilities.ErrInvalidID) {
				t.Fatalf("error = %v, want %v", err, utilities.ErrInvalidID)
			}
		})
	}
}
