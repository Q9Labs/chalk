package observability

import (
	"errors"
	"net"
	"net/url"
	"regexp"

	"github.com/jackc/pgx/v5/pgconn"
)

const driverFailureDetail = "database or network error"

var sqlStatePattern = regexp.MustCompile(`^[0-9A-Z]{5}$`)

// driverFailureAttrs returns the bounded facts of a Postgres driver or network
// failure: its class, the SQLSTATE, whether it happened while connecting and
// whether it timed out. It returns nil for any other error. The error text is
// never part of the result.
func driverFailureAttrs(err error) []any {
	var pgError *pgconn.PgError
	var connectError *pgconn.ConnectError
	var configError *pgconn.ParseConfigError
	var network net.Error
	var requestErr *url.Error
	var attrs []any
	isConnect := errors.As(err, &connectError)
	switch {
	case errors.As(err, &pgError):
		attrs = []any{"error_class", "postgres"}
		if sqlStatePattern.MatchString(pgError.Code) {
			attrs = append(attrs, "sqlstate", pgError.Code)
		}
	case errors.As(err, &configError):
		attrs = []any{"error_class", "postgres_config"}
	case isConnect:
		attrs = []any{"error_class", "postgres_connect"}
	case errors.As(err, &requestErr):
		// HTTP client errors keep their own handling in LogHTTPError.
		return nil
	case errors.As(err, &network):
		attrs = []any{"error_class", "network"}
	default:
		return nil
	}
	return append(attrs, "connect", isConnect, "timeout", errors.As(err, &network) && network.Timeout())
}
