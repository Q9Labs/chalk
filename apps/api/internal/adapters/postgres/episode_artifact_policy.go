package postgres

import (
	"context"
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func resolveArtifactPolicyDocument(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, space sqlc.Space) ([]byte, error) {
	policy, err := queries.LockTenantArtifactPolicyForShare(ctx, uuid(tenantID))
	if err != nil {
		return nil, err
	}
	tenantPolicy := artifactpolicy.TenantPolicy{
		TranscriptionCeiling:      artifactpolicy.TranscriptionMode(policy.TranscriptionCeiling),
		TranscriptionDefault:      artifactpolicy.TranscriptionMode(policy.TranscriptionDefaultMode),
		ProviderPolicyVersion:     policy.ProviderPolicyVersion,
		RecordingRetention:        time.Duration(policy.RecordingRetentionSeconds) * time.Second,
		TranscriptRetention:       time.Duration(policy.TranscriptRetentionSeconds) * time.Second,
		TranscriptionSourceWindow: time.Duration(policy.SourceWindowSeconds) * time.Second,
	}
	return artifactPolicyDocument(tenantPolicy, artifactpolicy.SpacePolicy{
		Recording:     artifactpolicy.RecordingMode(space.RecordingPolicy),
		Transcription: artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
	})
}

func artifactPolicyDocument(tenantPolicy artifactpolicy.TenantPolicy, spacePolicy artifactpolicy.SpacePolicy) ([]byte, error) {
	snapshot, err := artifactpolicy.Resolve(tenantPolicy, spacePolicy)
	if err != nil {
		return nil, err
	}
	document, err := snapshot.Document()
	if err != nil {
		return nil, err
	}
	return json.Marshal(document)
}
