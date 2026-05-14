package ops

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/jackc/pgx/v5/pgtype"
)

func metadataJSON(v map[string]any) []byte {
	if len(v) == 0 {
		return []byte(`{}`)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return []byte(`{}`)
	}
	return data
}

func optionalString(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func actorOrSystem(actor Actor) Actor {
	if strings.TrimSpace(actor.ID) == "" {
		return Actor{Kind: domainops.ActorKindSystem, ID: "system"}
	}
	if actor.Kind == "" {
		actor.Kind = domainops.ActorKindSystem
	}
	return actor
}

func incidentCode(now time.Time) string {
	var suffix [3]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Sprintf("OPS-%s-%d", now.UTC().Format("20060102"), now.Unix())
	}
	return fmt.Sprintf("OPS-%s-%s", now.UTC().Format("20060102"), strings.ToUpper(hex.EncodeToString(suffix[:])))
}

func timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

func nullTimestamptz() pgtype.Timestamptz {
	return pgtype.Timestamptz{}
}

func nowIfZero(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t.UTC()
}

func titleCaseSeverity(severity domainops.Severity) string {
	switch severity {
	case domainops.SeverityCritical:
		return "Critical"
	case domainops.SeverityMajor:
		return "Major"
	case domainops.SeverityMinor:
		return "Minor"
	default:
		return "Info"
	}
}
