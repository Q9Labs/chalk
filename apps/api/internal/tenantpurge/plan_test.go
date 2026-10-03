package tenantpurge

import (
	"testing"
	"time"
)

func testScope() Scope {
	return Scope{Delete: []Identity{{"00000000-0000-4000-8000-000000000001", "Erase fixture"}}, Keep: []Identity{{"00000000-0000-4000-8000-000000000002", "Keep fixture"}}}
}

func TestExplicitPartitionAndServiceExclusions(t *testing.T) {
	scope := testScope()
	if err := scope.Validate(); err != nil {
		t.Fatal(err)
	}
	scope.Keep = append(scope.Keep, scope.Delete[0])
	if err := scope.Validate(); err == nil {
		t.Fatal("overlap accepted")
	}
	scope = testScope()
	b := Backfill{ServiceTenantIDs: []string{scope.Keep[0].ID}, Spaces: []Space{{ID: "00000000-0000-4000-8000-000000000003", TenantID: scope.Keep[0].ID}}}
	if err := b.Validate(scope); err == nil {
		t.Fatal("service Space accepted")
	}
	b.Spaces = nil
	if err := b.Validate(scope); err != nil {
		t.Fatal(err)
	}
}

func TestBackupReceiptBindsRowsAndFourteenDayRetention(t *testing.T) {
	now := time.Now().UTC()
	p := Plan{Version: 1, Kind: "purge", Scope: testScope(), Tables: []Table{{Name: "tenants", Count: 1, Digest: Digest([]byte("before"))}}}
	digest, err := p.Digest()
	if err != nil {
		t.Fatal(err)
	}
	r := BackupReceipt{PlanDigest: digest, ArchivePath: "/private/backup.enc", ArchiveDigest: Digest([]byte("ciphertext")), RestoreVerified: true, RestoreTables: p.Tables, CompletedAt: now.Add(-time.Minute), RetainUntil: now.Add(14 * 24 * time.Hour)}
	if err := r.Validate(p, now); err != nil {
		t.Fatal(err)
	}
	r.RetainUntil = now.Add(time.Hour)
	if err := r.Validate(p, now); err == nil {
		t.Fatal("short retention accepted")
	}
	r.RetainUntil = now.Add(14 * 24 * time.Hour)
	r.RestoreTables = []Table{{Name: "tenants", Count: 1, Digest: Digest([]byte("different"))}}
	if err := r.Validate(p, now); err == nil {
		t.Fatal("different restored bytes accepted")
	}
}

func TestUnknownCycleFailsClosed(t *testing.T) {
	if _, err := DeleteOrder([]string{"a", "b"}, map[string][]string{"a": {"b"}, "b": {"a"}}); err == nil {
		t.Fatal("cycle accepted")
	}
	order, err := DeleteOrder([]string{"parent", "child"}, map[string][]string{"child": {"parent"}})
	if err != nil || len(order) != 2 || order[0] != "child" {
		t.Fatalf("order=%v err=%v", order, err)
	}
}

func TestRowDriftAndBackupValueRedaction(t *testing.T) {
	p := Plan{Version: 1, Kind: "purge", SchemaDigest: "schema", Tables: []Table{{Name: "users", Count: 1, Digest: "old", Rows: []Row{{Key: []byte(`{"id":"fixture"}`), Value: []byte(`{"secret":"fixture"}`)}}}}}
	if len(p.WithoutValues().Tables[0].Rows[0].Value) != 0 || len(p.Tables[0].Rows[0].Value) == 0 {
		t.Fatal("redaction changed original or leaked backup")
	}
	changed := p
	changed.Tables = []Table{{Name: "users", Count: 1, Digest: "new"}}
	if SameRows(p, changed) == nil {
		t.Fatal("byte drift accepted")
	}
}

func TestWriteDrainRejectsMissingOrLivePermissions(t *testing.T) {
	now := time.Now().UTC()
	var missing *WriteDrain
	if missing.Validate(now) == nil {
		t.Fatal("unproved write drain accepted")
	}
	live := WriteDrain{NotBefore: now.Add(time.Minute)}
	if live.Validate(now) == nil {
		t.Fatal("live upload permissions accepted")
	}
	expired := WriteDrain{NotBefore: now.Add(-time.Minute)}
	if err := expired.Validate(now); err != nil {
		t.Fatal(err)
	}
}
