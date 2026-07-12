package postgres

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// chunkResultKey is API-owned and attempt-qualified. The source chunk key is
// never rewritten: retries only change the dispatcher result destination.
func chunkResultKey(tenantID, transcriptID utilities.ID, generation int64, chunkIndex, attempt int) string {
	return fmt.Sprintf("tenants/%s/transcripts/%s/chunks/%d/%d/attempt-%d.json", tenantID, transcriptID, generation, chunkIndex, attempt)
}

// finalArtifactKey is API-owned and fenced by the finalizer lease attempt.
func finalArtifactKey(tenantID, transcriptID utilities.ID, attempt int) string {
	return fmt.Sprintf("tenants/%s/transcripts/%s/attempts/%d/document.json", tenantID, transcriptID, attempt)
}
