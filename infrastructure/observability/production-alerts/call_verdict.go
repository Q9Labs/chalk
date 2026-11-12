package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The verdict rules and thresholds mirror scripts/diagnose-call (the command an engineer runs by hand).
// Both read call-verdict.json and both pass scripts/diagnose-call/fixtures/cases.json, so they cannot drift unseen.

//go:embed call-verdict.json
var callVerdictJSON []byte

type verdictThresholds struct {
	SilenceMS          int64   `json:"silence_ms"`
	StarvedFloorKbps   float64 `json:"starved_floor_kbps"`
	StarvedMS          int64   `json:"starved_ms"`
	HealthyLossPct     float64 `json:"healthy_loss_pct"`
	HealthyRTTMS       float64 `json:"healthy_rtt_ms"`
	EarlyReplacementMS int64   `json:"early_replacement_ms"`
	FlagWithinMS       int64   `json:"flag_within_ms"`
}

func loadVerdictThresholds() verdictThresholds {
	var thresholds verdictThresholds
	if err := json.Unmarshal(callVerdictJSON, &thresholds); err != nil {
		panic("call-verdict.json is not valid: " + err.Error())
	}
	return thresholds
}

// logRow is one Axiom row of a call: an API log line (the SDK's reports arrive as API lines) or an SFU node event.
type logRow struct {
	time        time.Time
	event       string
	sfu         bool
	participant string
	connection  string
	journey     string
	attrs       map[string]any
}

var legacyEvents = map[string]string{
	"SDK call stats":               "sdk.call_stats",
	"SDK audio receive summary":    "sdk.connection_report",
	"SDK connection failure":       "sdk.connection_report",
	"media connection replacement": "media.connection_replacement",
}

func flatten(prefix string, value any, into map[string]any) {
	if object, ok := value.(map[string]any); ok {
		for key, child := range object {
			if prefix != "" {
				key = prefix + "." + key
			}
			flatten(key, child, into)
		}
		return
	}
	into[prefix] = value
}

func (r logRow) text(name string) string {
	for _, key := range []string{name, "attributes." + name} {
		if value, ok := r.attrs[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

func (r logRow) number(name string) (float64, bool) {
	value, ok := r.attrs["attributes."+name].(float64)
	return value, ok
}

func normalizeLogRow(raw map[string]any) logRow {
	attrs := map[string]any{}
	flatten("", raw, attrs)
	row := logRow{attrs: attrs}
	row.time, _ = time.Parse(time.RFC3339Nano, row.text("_time"))
	row.event = row.text("event")
	if row.event == "" {
		row.event = legacyEvents[row.text("body")]
	}
	row.sfu = row.text("service.name") == "chalk-sfu"
	row.participant = row.text("participant_id_hash")
	if row.participant == "" && row.text("participant_id") != "" {
		sum := sha256.Sum256([]byte(row.text("participant_id")))
		row.participant = hex.EncodeToString(sum[:])
	}
	row.connection = row.text("connection_id")
	if row.connection == "" {
		row.connection = row.text("provider_session_id")
	}
	row.journey = row.text("journey_id")
	return row
}

type sample struct {
	row                *logRow
	participant, conn  string
	start, end         time.Time
	recv, send         *float64
	height, rtt, loss  *float64
	availableIncomingK *float64
	// hidden counts videos the viewer chose not to receive; they send nothing on purpose.
	hidden *float64
}

func optional(row *logRow, name string) *float64 {
	if value, ok := row.number(name); ok {
		return &value
	}
	return nil
}

func ms(value float64) time.Duration { return time.Duration(value * float64(time.Millisecond)) }

// samplesOf places each sample on a clock. A row's time is when the upload arrived and one upload carries several
// samples, so a sample's own time is its connection's media start plus elapsed_ms; the start is the earliest
// time-minus-elapsed among the rows of that one connection id.
func samplesOf(rows []logRow) []sample {
	origin := map[string]time.Time{}
	for i := range rows {
		row := &rows[i]
		if row.event != "sdk.call_stats" || row.connection == "" {
			continue
		}
		elapsed, _ := row.number("elapsed_ms")
		start := row.time.Add(-ms(elapsed))
		if seen, ok := origin[row.connection]; !ok || start.Before(seen) {
			origin[row.connection] = start
		}
	}
	var samples []sample
	for i := range rows {
		row := &rows[i]
		if row.event != "sdk.call_stats" || row.connection == "" {
			continue
		}
		elapsed, _ := row.number("elapsed_ms")
		window, _ := row.number("window_ms")
		end := origin[row.connection].Add(ms(elapsed))
		samples = append(samples, sample{
			row: row, participant: row.participant, conn: row.connection, start: end.Add(-ms(window)), end: end,
			recv: optional(row, "recv_bitrate_kbps"), send: optional(row, "send_bitrate_kbps"),
			height: optional(row, "recv_height"), rtt: optional(row, "rtt_ms"), loss: optional(row, "recv_loss_pct"),
			availableIncomingK: optional(row, "available_incoming_kbps"), hidden: optional(row, "recv_hidden_videos"),
		})
	}
	sort.SliceStable(samples, func(a, b int) bool { return samples[a].start.Before(samples[b].start) })
	return samples
}

func hiddenByViewer(s sample) bool { return s.hidden != nil && *s.hidden > 0 }

type sampleRun struct {
	participant, conn string
	from, to          time.Time
	samples           []sample
}

func runsOf(samples []sample, match func(sample) bool) []sampleRun {
	var runs []sampleRun
	byConnection := map[string][]sample{}
	var order []string
	for _, s := range samples {
		if _, ok := byConnection[s.conn]; !ok {
			order = append(order, s.conn)
		}
		byConnection[s.conn] = append(byConnection[s.conn], s)
	}
	for _, conn := range order {
		var current *sampleRun
		for _, s := range byConnection[conn] {
			switch {
			case !match(s):
				current = nil
			case current != nil && !s.start.After(current.to.Add(2*time.Second)):
				current.to = s.end
				current.samples = append(current.samples, s)
			default:
				runs = append(runs, sampleRun{participant: s.participant, conn: conn, from: s.start, to: s.end, samples: []sample{s}})
				current = &runs[len(runs)-1]
			}
		}
	}
	return runs
}

func positive(value *float64) bool { return value != nil && *value > 0 }

// finding is one thing the rules call bad (or, when benign, a quiet stretch the Participant chose). stage names the
// step of the media path that failed and side whose it is: publisher, viewer, SFU, API, Sync, client, network or unknown.
type finding struct {
	kind, participant, experience, cause, stage, side string
	from, to                                          time.Time
	benign                                            bool
}

type verdictCause struct{ text, stage, side string }

var findingOrder = map[string]int{"failed_join": 0, "media_silence": 1, "publisher_silent": 2, "starved_viewer": 3, "congested_viewer": 4, "early_replacement": 5, "viewer_hid_video": 6}

func diagnoseRows(rows []logRow, t verdictThresholds) []finding {
	rows = append([]logRow(nil), rows...)
	sort.SliceStable(rows, func(a, b int) bool { return rows[a].time.Before(rows[b].time) })
	samples := samplesOf(rows)
	var findings []finding
	add := func(kind, participant string, from, to time.Time, experience string, why verdictCause, benign bool) {
		findings = append(findings, finding{kind: kind, participant: participant, from: from, to: to, experience: experience, cause: why.text, stage: why.stage, side: why.side, benign: benign})
	}
	silence := time.Duration(t.SilenceMS) * time.Millisecond
	long := time.Duration(t.StarvedMS) * time.Millisecond

	for i := range rows {
		if report := &rows[i]; report.event == "sdk.connection_report" && report.text("trigger") == "join_failed" {
			add("failed_join", report.participant, report.time, report.time, "could not join", joinCause(rows, report), false)
		}
	}

	for _, r := range runsOf(samples, func(s sample) bool { return s.recv != nil && *s.recv == 0 && !hiddenByViewer(s) }) {
		duration := r.to.Sub(r.from)
		if duration <= silence || !senderWasSending(samples, r) || !receivedBefore(samples, r) {
			continue
		}
		add("media_silence", r.participant, r.from, r.to, fmt.Sprintf("received no media for %d s while a sender was sending", seconds(duration)), silenceCause(rows, r), false)
	}

	for _, r := range runsOf(samples, func(s sample) bool { return s.send != nil && *s.send == 0 }) {
		duration := r.to.Sub(r.from)
		if duration <= silence || !someoneElseReported(samples, r) {
			continue
		}
		add("publisher_silent", r.participant, r.from, r.to, fmt.Sprintf("sent no media for %d s while another Participant was in the call", seconds(duration)), publishCause(rows, r), false)
	}

	linkFault := func(s sample) [3]bool {
		return [3]bool{
			s.loss != nil && *s.loss > t.HealthyLossPct,
			s.rtt != nil && *s.rtt > t.HealthyRTTMS,
			s.availableIncomingK != nil && *s.availableIncomingK < 4*t.StarvedFloorKbps,
		}
	}
	faulty := func(s sample) bool { f := linkFault(s); return f[0] || f[1] || f[2] }
	lowVideo := func(s sample) bool {
		return s.height != nil && s.recv != nil && *s.recv > 0 && *s.recv < t.StarvedFloorKbps && !hiddenByViewer(s)
	}
	peakOf := func(r sampleRun) float64 {
		peak := 0.0
		for _, s := range r.samples {
			peak = max(peak, *s.recv)
		}
		return peak
	}
	for _, r := range runsOf(samples, func(s sample) bool { return lowVideo(s) && !faulty(s) }) {
		if duration := r.to.Sub(r.from); duration > long {
			add("starved_viewer", r.participant, r.from, r.to, fmt.Sprintf("received video at %d kbps or less for %d s on a healthy link", int(peakOf(r)), seconds(duration)), starvedCause(rows, r), false)
		}
	}
	for _, r := range runsOf(samples, func(s sample) bool { return lowVideo(s) && faulty(s) }) {
		if duration := r.to.Sub(r.from); duration > long {
			add("congested_viewer", r.participant, r.from, r.to, fmt.Sprintf("received video at %d kbps or less for %d s on a poor link", int(peakOf(r)), seconds(duration)),
				verdictCause{"the viewer's link was poor (" + describeLink(r, linkFault) + ")", "receiving", "network"}, false)
		}
	}

	for i := range rows {
		row := &rows[i]
		if row.event != "media.connection_replacement" {
			continue
		}
		joined, ok := joinedAt(rows, row.participant)
		if !ok || row.time.Sub(joined) > time.Duration(t.EarlyReplacementMS)*time.Millisecond {
			continue
		}
		add("early_replacement", row.participant, joined, row.time, fmt.Sprintf("had the media connection replaced %d s after joining", seconds(row.time.Sub(joined))),
			verdictCause{replacementCause(row), "reconnecting", "API"}, false)
	}

	for _, r := range runsOf(samples, func(s sample) bool { return hiddenByViewer(s) && s.recv != nil && *s.recv < t.StarvedFloorKbps }) {
		if duration := r.to.Sub(r.from); duration > silence {
			add("viewer_hid_video", r.participant, r.from, r.to, fmt.Sprintf("hid its own video for %d s, so little or no media arrived", seconds(duration)),
				verdictCause{"the viewer's tile or page was hidden, which the SDK treats as a reason to stop receiving", "receiving", "viewer"}, true)
		}
	}

	sort.SliceStable(findings, func(a, b int) bool {
		if findingOrder[findings[a].kind] != findingOrder[findings[b].kind] {
			return findingOrder[findings[a].kind] < findingOrder[findings[b].kind]
		}
		return findings[a].from.Before(findings[b].from)
	})
	return findings
}

// describeLink names each measure that crossed its threshold in the run, with its worst value.
func describeLink(r sampleRun, linkFault func(sample) [3]bool) string {
	var parts []string
	number := func(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }
	extreme := func(largest bool, read func(sample) *float64) string {
		var value *float64
		for _, s := range r.samples {
			if v := read(s); v != nil {
				if value == nil {
					value = v
				} else {
					merged := min(*value, *v)
					if largest {
						merged = max(*value, *v)
					}
					value = &merged
				}
			}
		}
		return number(*value)
	}
	flagged := [3]bool{}
	for _, s := range r.samples {
		for i, faulty := range linkFault(s) {
			flagged[i] = flagged[i] || faulty
		}
	}
	if flagged[0] {
		parts = append(parts, extreme(true, func(s sample) *float64 { return s.loss })+"% loss at worst")
	}
	if flagged[1] {
		parts = append(parts, extreme(true, func(s sample) *float64 { return s.rtt })+" ms round trip at worst")
	}
	if flagged[2] {
		parts = append(parts, extreme(false, func(s sample) *float64 { return s.availableIncomingK })+" kbps available at best")
	}
	return strings.Join(parts, ", ")
}

// someoneElseReported is true when another Participant reported stats while the run lasted, so there was someone to send to.
func someoneElseReported(samples []sample, r sampleRun) bool {
	for _, s := range samples {
		if s.participant != r.participant && s.end.After(r.from) && s.start.Before(r.to) {
			return true
		}
	}
	return false
}

func publishCause(rows []logRow, r sampleRun) verdictCause {
	events := nodeEvents(rows, r.conn)
	if stopped := lastBefore(events, "sfu.publication.stopped", r.to); stopped != nil {
		return verdictCause{"the node stopped the publication (" + orNotLogged(stopped.text("reason")) + ") and the client sent nothing after it", "publishing", "SFU"}
	}
	for _, event := range events {
		if event.event == "sfu.publication.started" {
			return verdictCause{"the node accepted the publication and the client's sender then sent 0 kbps", "publishing", "publisher"}
		}
	}
	if len(events) == 0 {
		return verdictCause{"the client's sender sent 0 kbps; the SFU node logged no event for this connection, so the node's part is not proved", "publishing", "publisher"}
	}
	return verdictCause{"the node logged no publication for this connection, and the client's sender sent 0 kbps", "publishing", "publisher"}
}

// joinStepSides names whose a failed join step is.
var joinStepSides = map[string]string{
	"acquire_initial_media": "client", "access_initialize": "API", "create_media_client": "SFU", "start_media": "SFU",
	"create_sync_client": "Sync", "start_sync": "Sync", "wait_for_sync_live": "Sync", "confirm_entered": "Sync",
}

// joinCause reads the API refusal that shares the report's journey, else the step the client report says failed first.
// The report is a JSON string; one that does not parse names no step.
func joinCause(rows []logRow, report *logRow) verdictCause {
	for i := range rows {
		if rows[i].event == "http.failure" && report.journey != "" && rows[i].journey == report.journey {
			return verdictCause{"the API refused the request (" + codeOrNotLogged(rows[i].text("error_code")) + ")", "access_initialize", "API"}
		}
	}
	var parsed struct {
		Events []struct {
			Event      string   `json:"event"`
			Step       string   `json:"step"`
			Outcome    string   `json:"outcome"`
			Code       string   `json:"code"`
			DurationMS *float64 `json:"duration_ms"`
		} `json:"events"`
	}
	if json.Unmarshal([]byte(report.text("report")), &parsed) == nil {
		for _, event := range parsed.Events {
			side, known := joinStepSides[event.Step]
			if event.Event != "space_join_span" || event.Outcome != "failed" || !known {
				continue
			}
			duration := 0.0
			if event.DurationMS != nil {
				duration = *event.DurationMS
			}
			return verdictCause{fmt.Sprintf("the join failed at %s (%s) after %d s", event.Step, codeOrNotLogged(event.Code), seconds(ms(duration))), event.Step, side}
		}
	}
	return verdictCause{"unknown: no failed API request shares the report's journey id and the report names no failed step", "joining", "unknown"}
}

func replacementCause(row *logRow) string {
	if cause := row.text("replacement_cause"); cause != "" {
		return cause
	}
	return "cause not logged"
}

func codeOrNotLogged(code string) string {
	if code == "" {
		return "code not logged"
	}
	return code
}

func seconds(d time.Duration) int { return int((d + 500*time.Millisecond) / time.Second) }

func senderWasSending(samples []sample, r sampleRun) bool {
	for _, s := range samples {
		if s.participant != r.participant && s.end.After(r.from) && s.start.Before(r.to) && positive(s.send) {
			return true
		}
	}
	return false
}

func receivedBefore(samples []sample, r sampleRun) bool {
	for _, s := range samples {
		if s.participant == r.participant && !s.end.After(r.from) && positive(s.recv) {
			return true
		}
	}
	return false
}

func nodeEvents(rows []logRow, conn string) []*logRow {
	var events []*logRow
	for i := range rows {
		if rows[i].sfu && rows[i].connection == conn {
			events = append(events, &rows[i])
		}
	}
	return events
}

func lastBefore(events []*logRow, name string, limit time.Time) *logRow {
	var found *logRow
	for _, event := range events {
		if event.event == name && !event.time.After(limit) {
			found = event
		}
	}
	return found
}

func orNotLogged(value string) string {
	if value == "" {
		return "not logged"
	}
	return value
}

func silenceCause(rows []logRow, r sampleRun) verdictCause {
	events := nodeEvents(rows, r.conn)
	resumed := false
	for _, event := range events {
		if !event.time.Before(r.from) && (event.event == "sfu.subscription.resumed" || event.event == "sfu.subscription.started") {
			resumed = true
		}
	}
	var replacement *logRow
	for i := range rows {
		if rows[i].event == "media.connection_replacement" && rows[i].participant == r.participant && !rows[i].time.After(r.to) {
			replacement = &rows[i]
		}
	}
	if paused := lastBefore(events, "sfu.subscription.paused", r.to); paused != nil && !resumed {
		side := map[string]string{"viewer": "viewer", "congestion": "network"}[paused.text("reason")]
		if side == "" {
			side = "SFU"
		}
		return verdictCause{"the node paused the subscription (" + orNotLogged(paused.text("reason")) + ") and did not resume it", "forwarding", side}
	}
	if lost := lastBefore(events, "sfu.source.lease_lost", r.to); lost != nil {
		return verdictCause{"the source lost its lease on the node (" + orNotLogged(lost.text("cause")) + ")", "publishing", "SFU"}
	}
	if replacement != nil && !resumed {
		return verdictCause{"the connection was replaced (" + orNotLogged(replacement.text("replacement_cause")) + ") and the node logged no subscription starting on the new one", "reconnecting", "API"}
	}
	if len(events) == 0 {
		return verdictCause{"unknown: the SFU node logged no event for this connection", "unknown", "unknown"}
	}
	return verdictCause{"unknown: the node events for this connection do not explain it", "unknown", "unknown"}
}

func starvedCause(rows []logRow, r sampleRun) verdictCause {
	layer := lastBefore(nodeEvents(rows, r.conn), "sfu.subscription.layer", r.to)
	if layer == nil {
		return verdictCause{"unknown: the SFU node logged no layer for this connection", "unknown", "unknown"}
	}
	now, ceiling, limit := orNotLogged(layer.text("layer")), orNotLogged(layer.text("ceiling")), orNotLogged(layer.text("server_limit"))
	switch {
	case limit == "low" && ceiling != "low":
		return verdictCause{fmt.Sprintf("the node held the viewer to the %s layer (server limit %s, viewer ceiling %s)", now, limit, ceiling), "forwarding", "SFU"}
	case ceiling == "low":
		return verdictCause{fmt.Sprintf("the viewer asked for the %s layer (ceiling %s)", now, ceiling), "receiving", "viewer"}
	}
	return verdictCause{fmt.Sprintf("the node and the viewer allowed more than the %s layer, so the publisher sent no better one (ceiling %s, server limit %s)", now, ceiling, limit), "publishing", "publisher"}
}

func joinedAt(rows []logRow, participant string) (time.Time, bool) {
	for i := range rows {
		if rows[i].participant == participant {
			return rows[i].time, true
		}
	}
	return time.Time{}, false
}

// verdictLine is the one line a person reads: who, what they lived through, from when to when, the failing stage and side, and why.
func verdictLine(findings []finding) string {
	var first, note *finding
	for i := range findings {
		switch {
		case !findings[i].benign && first == nil:
			first = &findings[i]
		case findings[i].benign && note == nil:
			note = &findings[i]
		}
	}
	short := func(participant string) string {
		if len(participant) > 8 {
			return participant[:8]
		}
		return participant
	}
	if first == nil {
		none := "No bad call found by the rules: no failed join, media silence, silent publisher, starved or congested viewer or early replacement"
		if note != nil {
			return none + ". Participant " + short(note.participant) + " " + note.experience + " (stage: " + note.stage + ", side: " + note.side + ", by choice)."
		}
		return none + "."
	}
	window := "from " + first.from.UTC().Format("15:04:05") + " to " + first.to.UTC().Format("15:04:05")
	if first.from.Equal(first.to) {
		window = "at " + first.from.UTC().Format("15:04:05")
	}
	return "Participant " + short(first.participant) + " " + first.experience + " " + window + " UTC; failing stage: " + first.stage + ", side: " + first.side + "; cause: " + first.cause + "."
}

// episodeIDPattern keeps anything but an Episode id out of a query.
var episodeIDPattern = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

var idPattern = regexp.MustCompile(`^[\w.:-]{1,128}$`)

// axiomQuerier reads rows from one dataset. A dataset refuses a field it has never received, which is what it looks
// like before the build that logs the field is deployed, so callers get that field's name back.
type axiomQuerier struct {
	client       *http.Client
	token, org   string
	dataset, url string
}

var invalidField = regexp.MustCompile(`invalid field: \\?"attributes\.(\w+)\\?"`)

func (q axiomQuerier) rows(ctx context.Context, apl string, start, end time.Time) ([]logRow, string, error) {
	body, err := json.Marshal(map[string]string{
		"apl":       "['" + q.dataset + "'] | " + apl + " | take 5000",
		"startTime": start.UTC().Format(time.RFC3339), "endTime": end.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return nil, "", errors.New("call verdict query encoding failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, q.url+"/v1/datasets/_apl?format=legacy", bytes.NewReader(body))
	if err != nil {
		return nil, "", errors.New("call verdict query request failed")
	}
	request.Header.Set("Authorization", "Bearer "+q.token)
	request.Header.Set("Content-Type", "application/json")
	if q.org != "" {
		request.Header.Set("X-Axiom-Org-Id", q.org)
	}
	response, err := q.client.Do(request)
	if err != nil {
		return nil, "", errors.New("call verdict query failed")
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if response.StatusCode != http.StatusOK {
		if match := invalidField.FindSubmatch(payload); match != nil {
			return nil, string(match[1]), nil
		}
		return nil, "", fmt.Errorf("call verdict query answered HTTP %d", response.StatusCode)
	}
	var decoded struct {
		Matches []struct {
			Time string         `json:"_time"`
			Data map[string]any `json:"data"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, "", errors.New("call verdict query answer is not valid")
	}
	rows := make([]logRow, 0, len(decoded.Matches))
	for _, match := range decoded.Matches {
		raw := match.Data
		raw["_time"] = match.Time
		rows = append(rows, normalizeLogRow(raw))
	}
	return rows, "", nil
}

// episodeRows reads every row that names the Episode, then the SFU node events of the connections those rows name.
// Both reads are by id; the time range only bounds how much of the dataset a query scans.
func (q axiomQuerier) episodeRows(ctx context.Context, episodeID string, endedAt time.Time) ([]logRow, error) {
	if !episodeIDPattern.MatchString(episodeID) {
		return nil, errors.New("call verdict refused an Episode id that is not one")
	}
	start, end := endedAt.Add(-24*time.Hour), endedAt.Add(10*time.Minute)
	rows, _, err := q.rows(ctx, "where ['attributes.episode_id'] == '"+episodeID+"'", start, end)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var quoted []string
	for _, row := range rows {
		if row.connection != "" && idPattern.MatchString(row.connection) && !seen[row.connection] && len(quoted) < 200 {
			seen[row.connection] = true
			quoted = append(quoted, "'"+row.connection+"'")
		}
	}
	if len(quoted) == 0 {
		return rows, nil
	}
	events, missing, err := q.rows(ctx, "where ['service.name'] == 'chalk-sfu' and ['attributes.connection_id'] in ("+strings.Join(quoted, ", ")+")", start, end)
	if err != nil {
		return rows, err
	}
	if missing != "" {
		return rows, nil // The node has not exported events to this dataset yet.
	}
	return append(rows, events...), nil
}

type endedEpisode struct {
	tenantID, tenantName, episodeID string
	endedAt                         time.Time
}

// endedEpisodesSQL lists Episodes that ended a moment ago and had a Participant. The collector looks at a one-minute
// band so that each Episode is judged once, when its last SDK uploads have landed.
const endedEpisodesSQL = `select episodes.tenant_id::text, coalesce(tenants.name, ''), episodes.id::text, episodes.ended_at from episodes
left join tenants on tenants.id = episodes.tenant_id
where status = 'ended' and episodes.ended_at <= now() - $1::int * interval '1 second' and episodes.ended_at > now() - $2::int * interval '1 second'
  and exists (select 1 from participants where participants.episode_id = episodes.id)
order by episodes.ended_at limit 10`

func collectEndedEpisodes(ctx context.Context, databaseURL string, settle, band time.Duration) ([]endedEpisode, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	config.RuntimeParams["default_transaction_read_only"] = "on"
	config.RuntimeParams["statement_timeout"] = "5000"
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, errors.New("ended Episode database connection failed")
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, endedEpisodesSQL, int(settle.Seconds()), int((settle + band).Seconds()))
	if err != nil {
		return nil, errors.New("ended Episode query failed")
	}
	defer rows.Close()
	var episodes []endedEpisode
	for rows.Next() {
		var episode endedEpisode
		if err := rows.Scan(&episode.tenantID, &episode.tenantName, &episode.episodeID, &episode.endedAt); err != nil {
			return nil, errors.New("ended Episode result decoding failed")
		}
		episodes = append(episodes, episode)
	}
	return episodes, rows.Err()
}

// collectCallVerdicts judges each ended Episode and returns one alert row for each bad one. A failure to read one
// Episode drops that Episode only; the collector's own state rows never wait on it.
func collectCallVerdicts(ctx context.Context, querier axiomQuerier, episodes []endedEpisode, thresholds verdictThresholds) ([]snapshot, error) {
	var snapshots []snapshot
	var failed error
	for _, episode := range episodes {
		rows, err := querier.episodeRows(ctx, episode.episodeID, episode.endedAt)
		if err != nil {
			failed = err
			continue
		}
		findings := diagnoseRows(rows, thresholds)
		if !hasBadFinding(findings) {
			continue
		}
		snapshots = append(snapshots, snapshot{
			Rule: callVerdictRulePrefix + episode.episodeID, Tenant: episode.tenantID, TenantName: episode.tenantName, Value: 1,
			Summary: verdictLine(findings) + " Episode " + episode.episodeID + ".",
		})
	}
	return snapshots, failed
}

// hasBadFinding is false for a call with nothing wrong and for one whose only finding is a stretch the viewer chose.
func hasBadFinding(findings []finding) bool {
	for _, f := range findings {
		if !f.benign {
			return true
		}
	}
	return false
}

// callVerdictRulePrefix starts the rule of every call-verdict row. The Episode id ends it, so the failure monitor,
// which keeps the latest row of each rule and Tenant, raises one alert for each bad Episode.
const callVerdictRulePrefix = "call-verdict "

// collectCallVerdictsFromEnv judges the Episodes that ended a moment ago. It returns nothing when it cannot read,
// because a missing verdict must not look like a failing call. The failure goes to stderr without the secret.
func collectCallVerdictsFromEnv(ctx context.Context, client *http.Client) []snapshot {
	ctx, cancel := context.WithTimeout(ctx, callVerdictBudget)
	defer cancel()
	querier := axiomQuerier{
		client: client, token: os.Getenv("CHALK_ALERT_AXIOM_QUERY_TOKEN"), org: os.Getenv("CHALK_ALERT_AXIOM_ORG_ID"),
		dataset: os.Getenv("CHALK_ALERT_QUERY_DATASET"), url: "https://api.axiom.co",
	}
	if querier.dataset == "" {
		querier.dataset = os.Getenv("CHALK_ALERT_LOG_DATASET")
	}
	thresholds := loadVerdictThresholds()
	episodes, err := collectEndedEpisodes(ctx, os.Getenv("CHALK_DATABASE_URL"), callVerdictSettle, callVerdictBand)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return nil
	}
	snapshots, err := collectCallVerdicts(ctx, querier, episodes, thresholds)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	return snapshots
}

// An Episode is judged between callVerdictSettle and callVerdictSettle+callVerdictBand after it ended: the wait lets
// the last SDK uploads land, and the band is the collector's period, so each Episode is judged once.
//
// The verdict row is therefore written no later than callVerdictSettle + callVerdictBand + callVerdictBudget after the
// Episode ended, which call-verdict.json bounds with flag_within_ms.
const (
	callVerdictSettle = 30 * time.Second
	callVerdictBand   = time.Minute
	callVerdictBudget = 12 * time.Second
)
