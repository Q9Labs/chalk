package spiffe

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/depcheck"
)

func TestImportDirection(t *testing.T) {
	depcheck.Forbid(t, "recorderworker", "recorderfleet", "recorderprotocol", "httpapi", "adapters/postgres")
}
