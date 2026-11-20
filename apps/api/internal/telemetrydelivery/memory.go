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

// SinkWrite writes the sink rows of the records an admission calls new. A ledger calls it after
// it has admitted a batch and before it commits, so a failure leaves the ledger as it was and
// the retry writes the rows again.
type SinkWrite func(context.Context, Admission) error

// MemoryLedger is the ledger in memory, for tests and for a server with no database. It keeps
// the contract of the Postgres ledger: a batch is admitted under one lock, the sink is written
// before the rows change, and an error from either leaves every row as it was.
type MemoryLedger struct {
	mu   sync.Mutex
	rows map[rowKey]SourceRow
	// Fail, when set, makes every call fail before it touches anything.
	Fail error
	// CrashAfterSink, when set, makes Admit fail after the sink write and before the rows change,
	// the way a crash between the two would.
	CrashAfterSink error
}

type rowKey struct{ tenant, source, participant utilities.ID }

// Admit admits one batch for the participant the identity names. See telemetrydelivery.Admit.
func (l *MemoryLedger) Admit(ctx context.Context, identity Identity, batch sdktelemetry.Request, received time.Time, write SinkWrite) (Admission, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return Admission{}, l.Fail
	}
	sources, err := Sources(batch)
	if err != nil {
		return Admission{}, err
	}
	existing := make(map[utilities.ID]SourceRow, len(sources))
	for _, source := range sources {
		if row, found := l.rows[rowKey{identity.TenantID, source, identity.ParticipantID}]; found {
			existing[source] = row
		}
	}
	admission, err := Admit(identity, existing, batch, received)
	if err != nil {
		return Admission{}, err
	}
	if err := write(ctx, admission); err != nil {
		return Admission{}, err
	}
	if l.CrashAfterSink != nil {
		return Admission{}, l.CrashAfterSink
	}
	if l.rows == nil {
		l.rows = map[rowKey]SourceRow{}
	}
	for _, row := range admission.Rows {
		l.rows[rowKey{row.TenantID, row.SourceID, row.ParticipantID}] = row
	}
	return admission, nil
}

// Source returns the rows of one source, one per participant, ordered by participant.
func (l *MemoryLedger) Source(_ context.Context, tenant, source utilities.ID) ([]SourceRow, error) {
	return l.matching(func(key rowKey, _ SourceRow) bool { return key.tenant == tenant && key.source == source })
}

// Episode returns the rows of every source that sent records for the Episode.
func (l *MemoryLedger) Episode(_ context.Context, tenant, episode utilities.ID) ([]SourceRow, error) {
	return l.matching(func(key rowKey, row SourceRow) bool { return key.tenant == tenant && row.EpisodeID == episode })
}

func (l *MemoryLedger) matching(keep func(rowKey, SourceRow) bool) ([]SourceRow, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Fail != nil {
		return nil, l.Fail
	}
	rows := []SourceRow{}
	for key, row := range l.rows {
		if keep(key, row) {
			row.Ranges = row.Ranges.clone()
			rows = append(rows, row)
		}
	}
	slices.SortFunc(rows, func(a, b SourceRow) int {
		return strings.Compare(a.SourceID.String()+a.ParticipantID.String(), b.SourceID.String()+b.ParticipantID.String())
	})
	return rows, nil
}
