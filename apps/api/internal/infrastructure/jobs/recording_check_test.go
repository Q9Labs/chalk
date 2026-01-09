package jobs

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewRecordingChecker(t *testing.T) {
	checker := NewRecordingChecker(nil, nil)
	assert.NotNil(t, checker)
	assert.Nil(t, checker.db)
	assert.Nil(t, checker.cfClient)
}

func TestRecordingChecker_CheckStalledRecordings_NilDB_Panics(t *testing.T) {
	// This test documents that nil DB causes a panic
	// In production, DB should never be nil
	checker := NewRecordingChecker(nil, nil)
	ctx := context.Background()

	assert.Panics(t, func() {
		_ = checker.CheckStalledRecordings(ctx)
	})
}

// Note: Run tests require a database connection since Run calls
// CheckStalledRecordings immediately on start. Integration tests
// with a test database should be used for full Run testing.
