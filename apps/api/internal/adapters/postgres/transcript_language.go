package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
)

func storedTranscriptLanguage(value string) artifactpolicy.TranscriptLanguage {
	// PostgreSQL constrains persisted values to the same primary-code allowlist.
	if value == "" {
		return artifactpolicy.TranscriptLanguage{}
	}
	mode, err := artifactpolicy.ParseTranscriptLanguage(value)
	if err != nil {
		panic("invalid persisted transcript language")
	}
	return mode
}
func nullableTranscriptLanguage(value pgtype.Text) *artifactpolicy.TranscriptLanguage {
	if !value.Valid {
		return nil
	}
	mode := storedTranscriptLanguage(value.String)
	return &mode
}
func optionalLanguageString(mode *artifactpolicy.TranscriptLanguage) *string {
	if mode == nil {
		return nil
	}
	value := mode.String()
	return &value
}
func optionalLanguageValue(mode *artifactpolicy.TranscriptLanguage) string {
	if mode == nil {
		return "auto"
	}
	return mode.String()
}
