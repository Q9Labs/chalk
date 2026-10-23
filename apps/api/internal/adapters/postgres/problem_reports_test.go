package postgres

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"testing"
)

func TestReportJourneyDatabaseFailures(t *testing.T) {
	for _, test := range []struct {
		code string
		want error
	}{
		{"42501", problemreports.ErrJourneyPermission},
		{"28000", problemreports.ErrJourneyPermission},
		{"23505", problemreports.ErrJourneyConstraint},
		{"22001", problemreports.ErrJourneyConstraint},
		{"08006", problemreports.ErrJourneyUnavailable},
	} {
		err := reportJourneyError(&pgconn.PgError{Code: test.code, Message: "private database diagnostic"})
		if !errors.Is(err, test.want) {
			t.Errorf("SQLSTATE %s did not retain a bounded cause", test.code)
		}
	}
	for _, err := range []error{context.DeadlineExceeded, context.Canceled, nil} {
		if !errors.Is(reportJourneyError(err), err) {
			t.Fatal("context outcome lost")
		}
	}
}
