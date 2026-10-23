package postgres

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type reportAttributionCapture struct{ delivery problemreports.Delivery }

func (c *reportAttributionCapture) Send(_ context.Context, delivery problemreports.Delivery) error {
	c.delivery = delivery
	return nil
}

func TestProblemReportDoesNotAddFallbackAccountEmail(t *testing.T) {
	pool := purgeIntegrationPool(t)
	fixture := createPurgeFixture(t, pool)
	ctx := context.Background()
	parse := func(raw string) utilities.ID {
		t.Helper()
		id, err := utilities.ParseID(raw)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	var episode string
	if err := pool.QueryRow(ctx, `select id from episodes where tenant_id=$1 and space_id=$2`, fixture.erased, fixture.erasedSpace).Scan(&episode); err != nil {
		t.Fatal(err)
	}
	subject := accessgrants.Subject{TenantID: parse(fixture.erased), SpaceID: parse(fixture.erasedSpace), EpisodeID: parse(episode), ParticipantID: accountTenantIntegrationID(t), ParticipantGeneration: 1}
	email := fixture.exclusiveUser + "@purge.invalid"
	if _, err := pool.Exec(ctx, `update users set name=email where id=$1`, fixture.exclusiveUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into participants(id,tenant_id,space_id,episode_id,account_id,generation,status,role,capabilities,name) values($1,$2,$3,$4,$5,1,'active','owner','{subscribe}',$6)`, uuid(subject.ParticipantID), fixture.erased, fixture.erasedSpace, episode, fixture.exclusiveUser, email); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, role, want, wantRole string
		linked                     bool
	}{
		{email, "owner", "Space owner", "owner", false}, // Real dashboard admission leaves account_id NULL.
		{email, "owner", "Space owner", "owner", true},
		{email, "guest", "Participant", "guest", false},
		{"Guest <person@example.com>", "guest", "Participant", "guest", false},
		{"Camera owner", "owner", "Camera owner", "owner", false},
		{"🎥 Camera guest", "guest", "🎥 Camera guest", "guest", false},
	} {
		if _, err := pool.Exec(ctx, `update participants set name=$2, role=$3, account_id=case when $4 then $5::uuid else null end where id=$1`, uuid(subject.ParticipantID), test.name, test.role, test.linked, fixture.exclusiveUser); err != nil {
			t.Fatal(err)
		}
		capture := &reportAttributionCapture{}
		service := problemreports.NewService(NewProblemReportRepository(pool), capture)
		result, err := service.Send(ctx, subject, problemreports.Report{Description: "My camera stopped working."})
		if err != nil || result.Outcome != problemreports.OutcomeAccepted {
			t.Fatalf("send failed: %v", err)
		}
		if capture.delivery.ReporterName != test.want || capture.delivery.Role != test.wantRole {
			t.Fatal("delivery included fallback account email or lost genuine display name")
		}
	}
}
