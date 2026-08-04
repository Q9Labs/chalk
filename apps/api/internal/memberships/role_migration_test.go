package memberships

import (
	"os"
	"strings"
	"testing"
)

func TestMembershipRoleVocabularyMigrationMapsLegacyRolesAndFailsRollback(t *testing.T) {
	migration, err := os.ReadFile("../../db/migrations/20260805040000_membership_role_vocabulary.sql")
	if err != nil {
		t.Fatalf("read role vocabulary migration: %v", err)
	}
	sql := strings.ToLower(string(migration))
	for _, mapping := range []string{
		"when 'admin' then 'collaborator'",
		"when 'member' then 'collaborator'",
		"when 'viewer' then 'observer'",
		"where role in ('admin', 'member', 'viewer')",
	} {
		if !strings.Contains(sql, mapping) {
			t.Fatalf("migration is missing legacy role mapping %q", mapping)
		}
	}
	_, down, ok := strings.Cut(sql, "-- +goose down")
	if !ok {
		t.Fatal("migration is missing goose Down section")
	}
	if !strings.Contains(down, "raise exception") {
		t.Fatal("irreversible migration Down must fail explicitly")
	}
}

func TestRoleVocabularySnapshotAndHistoryRemainDistinct(t *testing.T) {
	snapshot, err := os.ReadFile("../../db/schema.sql")
	if err != nil {
		t.Fatalf("read schema snapshot: %v", err)
	}
	if !strings.Contains(strings.ToLower(string(snapshot)), "-- owner, collaborator, observer") {
		t.Fatal("fresh schema snapshot does not document canonical tenant roles")
	}
	baseline, err := os.ReadFile("../../db/migrations/20260803000000_wave1_space_episode_baseline.sql")
	if err != nil {
		t.Fatalf("read historical baseline: %v", err)
	}
	if !strings.Contains(strings.ToLower(string(baseline)), "-- owner, admin, member, viewer") {
		t.Fatal("historical baseline role vocabulary was rewritten")
	}
}
