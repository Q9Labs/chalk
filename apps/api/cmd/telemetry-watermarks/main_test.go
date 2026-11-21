package main

import (
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	tenantID  = "11111111-1111-4111-8111-111111111111"
	episodeID = "22222222-2222-4222-8222-222222222222"
	seatOne   = "33333333-3333-4333-8333-333333333333"
	seatTwo   = "44444444-4444-4444-8444-444444444444"
	closedID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	openID    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

func id(t *testing.T, value string) utilities.ID {
	t.Helper()
	parsed, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func event(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"left"}`, seq, seq)
}

func request(t *testing.T, source string, nextSeq int64, end string, events ...string) sdktelemetry.Request {
	t.Helper()
	endField := ""
	if end != "" {
		endField = fmt.Sprintf(`,"end":%q`, end)
	}
	body := fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":"5d1e0000-0000-4000-8000-000000000001","next_seq":%d%s,"events":[%s]}`, source, nextSeq, endField, strings.Join(events, ","))
	decoded, frame := sdktelemetry.Decode(strings.NewReader(body))
	if frame != "" {
		t.Fatalf("batch refused: %s", frame)
	}
	return decoded
}

func TestEpisodeReportGroupsRowsBySourceAndNamesEachSourcesGaps(t *testing.T) {
	ledger := &telemetrydelivery.MemoryLedger{}
	received := time.Date(2026, 11, 19, 1, 0, 0, 0, time.UTC)
	admit := func(participant, source string, req sdktelemetry.Request) {
		who := telemetrydelivery.Identity{TenantID: id(t, tenantID), EpisodeID: id(t, episodeID), ParticipantID: id(t, participant)}
		ledger.Join(who)
		if _, err := ledger.Admit(t.Context(), who, req, received, sdktelemetry.Stamp{}); err != nil {
			t.Fatal(err)
		}
	}
	// One seat closed cleanly with every seq stored; the other stopped at seq 2 with seq 1 missing and no end.
	admit(seatOne, closedID, request(t, closedID, 2, "closed", event(0), event(1)))
	admit(seatTwo, openID, request(t, openID, 3, "", event(0), event(2)))

	got, err := telemetrydelivery.EpisodeReport(t.Context(), ledger, id(t, tenantID), id(t, episodeID))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Sources) != 2 {
		t.Fatalf("sources = %d, want 2", len(got.Sources))
	}
	for _, source := range got.Sources {
		switch source.SourceID.String() {
		case closedID:
			if len(source.Gaps) != 0 || source.Watermark.End == nil || *source.Watermark.End != telemetrydelivery.EndClosed {
				t.Fatalf("closed source = %+v, want closed with no gaps", source)
			}
		case openID:
			if len(source.Gaps) != 2 || source.Gaps[0].Cause != telemetrydelivery.GapMissing || source.Gaps[1].Cause != telemetrydelivery.GapTailUnknown || source.Gaps[1].ToSeq != nil {
				t.Fatalf("open source gaps = %+v, want a missing range and an unknown tail", source.Gaps)
			}
		default:
			t.Fatalf("unexpected source %s", source.SourceID)
		}
	}
}

func TestRunNamesNoDatabaseUserNameOrHostWhenItCannotConnect(t *testing.T) {
	t.Setenv("CHALK_DATABASE_URL", "postgres://ledger-user:ledger-password@127.0.0.1:1/ledger-db?sslmode=disable&connect_timeout=2")
	err := run([]string{"--tenant", tenantID, "--episode", episodeID}, io.Discard)
	if err == nil {
		t.Fatal("run connected to a closed port")
	}
	for _, secret := range []string{"ledger-user", "ledger-password", "ledger-db", "127.0.0.1"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error %q names %s", err, secret)
		}
	}
}

func TestEpisodeReportOfAnEpisodeWithNoRowsHasNoSources(t *testing.T) {
	got, err := telemetrydelivery.EpisodeReport(t.Context(), &telemetrydelivery.MemoryLedger{}, id(t, tenantID), id(t, episodeID))
	if err != nil || got.Sources == nil || len(got.Sources) != 0 {
		t.Fatalf("got %+v, %v, want an empty list", got, err)
	}
}
