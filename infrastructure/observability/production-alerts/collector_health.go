package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Rules that say whether Chalk can serve at all. They are written every minute and read by readiness.apl.
const (
	ruleDatabase      = "database-unreachable"
	ruleRuntimeHealth = "runtime-health"
)

// unreachableError marks a failure to reach or read the database, as opposed to a bad configuration or a malformed snapshot.
type unreachableError string

func (e unreachableError) Error() string { return string(e) }

// snapshotError is the failure of reading the state rows: a database failure while consuming them is an unreachable
// database, and rows that read cleanly but cover too few rules are an incomplete snapshot.
func snapshotError(rowsErr error, rules int) error {
	if rowsErr != nil {
		return unreachableError("alert state rows could not be read")
	}
	if rules != 5 {
		return errors.New("alert state snapshot incomplete")
	}
	return nil
}

// healthRows gives the database row and the runtime-health row. The database row is the only row that
// still carries a failure when the database is down, because every other state row comes from it.
func healthRows(ctx context.Context, client *http.Client, snapshots []snapshot, databaseErr error) []snapshot {
	var rows []snapshot
	var unreachable unreachableError
	switch {
	case errors.As(databaseErr, &unreachable):
		rows = append(rows, snapshot{Rule: ruleDatabase, Value: 1, Reason: "unreachable"})
	case databaseErr == nil || len(snapshots) > 0:
		rows = append(rows, snapshot{Rule: ruleDatabase, Value: 0, Reason: "readable"})
	}
	return append(rows, collectRuntimeHealth(ctx, client, os.Getenv("CHALK_ALERT_API_READY_URL"), tunnelProbeURL()))
}

// tunnelProbeURL is the tunnel readiness URL, or empty when the host has no connector. Like chalk-runtime-health, the
// connector exists when its Quadlet is installed; an environment without the tunnel token has none, so nothing is
// checked there. CHALK_ALERT_TUNNEL_QUADLET names the file for a host that keeps its Quadlets elsewhere.
func tunnelProbeURL() string {
	quadlet := os.Getenv("CHALK_ALERT_TUNNEL_QUADLET")
	if quadlet == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		quadlet = filepath.Join(home, ".config/containers/systemd/chalk-cloudflared.container")
	}
	if _, err := os.Stat(quadlet); err != nil {
		return ""
	}
	if url := os.Getenv("CHALK_ALERT_TUNNEL_READY_URL"); url != "" {
		return url
	}
	return "http://127.0.0.1:12000/ready"
}

// collectRuntimeHealth probes what the host watchdog (chalk-runtime-health) probes: the API and, when the host has a
// connector (a tunnelURL), the tunnel. The
// watchdog only fails a systemd unit on the host; this row pages through the same path as every other rule.
func collectRuntimeHealth(ctx context.Context, client *http.Client, apiURL, tunnelURL string) snapshot {
	if apiURL == "" {
		apiURL = "http://127.0.0.1:18080/readyz"
	}
	item := snapshot{Rule: ruleRuntimeHealth, Reason: "healthy", Time: time.Now().UTC().Format(time.RFC3339Nano)}
	var failed []string
	probes := []struct{ name, url string }{{"api", apiURL}}
	if tunnelURL != "" {
		probes = append(probes, struct{ name, url string }{"tunnel", tunnelURL})
	}
	for _, probe := range probes {
		if !probeOK(ctx, client, probe.url) {
			failed = append(failed, probe.name)
		}
	}
	if len(failed) > 0 {
		item.Value, item.Reason = 1, strings.Join(failed, "+")+"_unhealthy"
	}
	return item
}

func probeOK(ctx context.Context, client *http.Client, endpoint string) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false
	}
	// A redirect to a healthy landing page must not turn a failed probe green.
	probeClient := *client
	probeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := probeClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

// healthMessage is the text of the rules above and the default for a rule with no text of its own, the delivery test.
func healthMessage(rule string) (headline, impact, next string) {
	switch rule {
	case ruleDatabase:
		return "The Chalk database cannot be reached", "The collector could not read the database in at least three of the last four minutes. Chalk cannot start classes or accept joins while this lasts, and Sync stays unready until the database returns.", "An engineer must check the database provider and the host's path to it now. Sync and the API wait for the database and recover by themselves; do not restart them."
	case ruleRuntimeHealth:
		return "A Chalk runtime check is failing", "The API or the public tunnel on the production host failed its local readiness check in at least three of the last four minutes. People may be unable to join or load classes.", "An engineer must check the host and the API now."
	default:
		return "TEST: Chalk alert delivery", "No customer failure was induced.", "This only tests notification delivery; no customer action is needed."
	}
}

// healthEngineers sets the engineer line of the rules that read the whole runtime.
func healthEngineers(item *snapshot) {
	switch item.Rule {
	case ruleSyncReadiness:
		item.Engineers = "For engineers: sync-readiness; inspect /readyz and sync.readiness.failed events, then systemctl status chalk-alert-state.timer chalk-alert-state.service."
	case ruleDatabase:
		item.Engineers = "For engineers: database-unreachable; check the database provider status, then journalctl -u chalk-alert-state for the failed read and the Sync and API /readyz bodies."
	case ruleRuntimeHealth:
		item.Engineers = "For engineers: runtime-health; run /usr/local/libexec/chalk-runtime-health on the host and read journalctl -u chalk-runtime-watchdog."
	}
}
