package telemetrydelivery

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// MemoryLedger is the ledger in memory, for tests and for a server with no database. It keeps the
// contract of the Postgres ledger: a batch is admitted under one lock, only for a participant that
// is live, only into a source that participant owns or has budget for, and an error from any step
// leaves every row as it was. This test double does not export payloads.
type MemoryLedger struct {
	mu   sync.Mutex
	rows map[sourceKey]SourceRow
	live map[Identity]bool
	// Fail, when set, makes every call fail before it touches anything.
	Fail error
	// FailCommit, when set, makes Admit fail after it worked out the admission and before the rows
	// change, the way a failed commit would.
	FailCommit error
}

type sourceKey struct{ tenant, source utilities.ID }

// Join makes the participant live, the way its row in participants does for the Postgres ledger.
func (l *MemoryLedger) Join(identity Identity) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.live == nil {
		l.live = map[Identity]bool{}
	}
	l.live[identity] = true
}

// Purge removes the tenant's participants and rows, the way a tenant purge does.
func (l *MemoryLedger) Purge(tenant utilities.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for identity := range l.live {
		if identity.TenantID == tenant {
			delete(l.live, identity)
		}
	}
	for key := range l.rows {
		if key.tenant == tenant {
			delete(l.rows, key)
		}
	}
}

// Admit admits one batch for the participant the identity names. See telemetrydelivery.Admit.
func (l *MemoryLedger) Admit(_ context.Context, identity Identity, batch sdktelemetry.Request, received time.Time, _ sdktelemetry.Stamp) (Admission, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return Admission{}, l.Fail
	}
	if !l.live[identity] {
		return Admission{}, ErrParticipantGone
	}
	source, err := SourceID(batch)
	if err != nil {
		return Admission{}, err
	}
	var existing *SourceRow
	if row, found := l.rows[sourceKey{identity.TenantID, source}]; found {
		existing = &row
	}
	owned := 0
	for _, row := range l.rows {
		if row.TenantID == identity.TenantID && row.ParticipantID == identity.ParticipantID {
			owned++
		}
	}
	admission, err := Admit(identity, existing, owned, batch, received)
	if err != nil {
		return Admission{}, err
	}
	if l.FailCommit != nil {
		return Admission{}, l.FailCommit
	}
	if l.rows == nil {
		l.rows = map[sourceKey]SourceRow{}
	}
	l.rows[sourceKey{identity.TenantID, source}] = admission.Row
	return admission, nil
}

// Live reports whether the identity's participant is live. See postgres.TelemetryLedger.Live.
func (l *MemoryLedger) Live(_ context.Context, identity Identity) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return l.Fail
	}
	if !l.live[identity] {
		return ErrParticipantGone
	}
	return nil
}

// Source returns the row of one source, and whether the ledger has one.
func (l *MemoryLedger) Source(_ context.Context, tenant, source utilities.ID) (SourceRow, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return SourceRow{}, false, l.Fail
	}
	row, found := l.rows[sourceKey{tenant, source}]
	if !found {
		return SourceRow{}, false, nil
	}
	row.Ranges = row.Ranges.Normalized()
	return row, true, nil
}

// Episode returns the row of every source the Episode's participants own, ordered by source id.
func (l *MemoryLedger) Episode(_ context.Context, tenant, episode utilities.ID) ([]SourceRow, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return nil, l.Fail
	}
	rows := []SourceRow{}
	for _, row := range l.rows {
		if row.TenantID == tenant && row.EpisodeID == episode {
			row.Ranges = row.Ranges.Normalized()
			rows = append(rows, row)
		}
	}
	slices.SortFunc(rows, func(a, b SourceRow) int { return strings.Compare(a.SourceID.String(), b.SourceID.String()) })
	return rows, nil
}
