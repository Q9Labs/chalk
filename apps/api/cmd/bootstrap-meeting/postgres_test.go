package main

import (
	"context"
	"strings"
	"testing"
)

func TestOpenBootstrapDatabaseDoesNotReturnConnectionMaterial(t *testing.T) {
	const databaseURL = "postgres://operator:do-not-print@%zz/chalk"
	_, err := openBootstrapDatabase(context.Background(), databaseURL)
	if err == nil {
		t.Fatal("invalid database URL was accepted")
	}
	if strings.Contains(err.Error(), databaseURL) || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("connection error exposed database material: %v", err)
	}
}
