package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type AxiomEvidence struct {
	client        *http.Client
	ingestURL     string
	authorization string
}

var axiomDatasetName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,80}$`)

// NewAxiomEvidence reuses the existing Axiom OTLP log dataset and ingest grant.
// The native ingest API gives the relay a synchronous, per-batch receipt.
func NewAxiomEvidence(endpoint, logHeaders string) (AxiomEvidence, error) {
	var sink AxiomEvidence
	if endpoint == "" || logHeaders == "" {
		return sink, nil
	}
	var dataset string
	for _, pair := range strings.Split(logHeaders, ",") {
		key, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		value, err := url.PathUnescape(strings.TrimSpace(value))
		if err != nil {
			return AxiomEvidence{}, errors.New("invalid Axiom log header encoding")
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "x-axiom-dataset":
			dataset = value
		case "authorization":
			sink.authorization = value
		}
	}
	if dataset == "" {
		// A generic OTLP collector may have headers but is not an Axiom endpoint.
		return AxiomEvidence{}, nil
	}
	if !axiomDatasetName.MatchString(dataset) || dataset == "." || dataset == ".." || !strings.HasPrefix(sink.authorization, "Bearer ") {
		return AxiomEvidence{}, errors.New("missing Axiom log dataset or ingest grant")
	}
	ingestURL, err := axiomIngestURL(endpoint, dataset)
	if err != nil {
		return AxiomEvidence{}, err
	}
	sink.ingestURL = ingestURL
	sink.client = &http.Client{
		Timeout: 8 * time.Second,
		// Do not forward the ingest grant or evidence to a redirected endpoint.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return sink, nil
}

func axiomIngestURL(endpoint, dataset string) (string, error) {
	base, err := url.Parse(endpoint)
	if err != nil || base.Hostname() == "" {
		return "", errors.New("invalid Axiom evidence endpoint")
	}
	if strings.EqualFold(base.Hostname(), "api.axiom.co") {
		return base.JoinPath("v1", "datasets", dataset, "ingest").String(), nil
	}
	return base.JoinPath("v1", "ingest", dataset).String(), nil
}

func (s AxiomEvidence) Enabled() bool { return s.client != nil }

func (s AxiomEvidence) Export(ctx context.Context, rows []json.RawMessage) error {
	payload, err := axiomEvidencePayload(rows)
	if err != nil {
		return errors.New("encode telemetry ingest request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.ingestURL, bytes.NewReader(payload))
	if err != nil {
		return errors.New("build telemetry ingest request")
	}
	request.Header.Set("Authorization", s.authorization)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return errors.New("send telemetry ingest request")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("telemetry ingest status %d", response.StatusCode)
	}
	var receipt struct {
		Ingested int               `json:"ingested"`
		Failed   int               `json:"failed"`
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&receipt); err != nil {
		return errors.New("read telemetry ingest receipt")
	}
	// Axiom can accept a row but drop fields, including indispensable proof
	// fields. Any warning keeps the original payload available for replay.
	if receipt.Ingested != len(rows) || receipt.Failed != 0 || len(receipt.Messages) != 0 {
		return errors.New("incomplete telemetry ingest receipt")
	}
	return nil
}

// Keep a fixed set of indexes in the shared logs schema. Axiom flattens maps
// into columns; new registry fields otherwise compete with service logs for
// columns and may silently disappear from a successful ingest.
func axiomEvidencePayload(rows []json.RawMessage) ([]byte, error) {
	type row struct {
		Service    json.RawMessage            `json:"service"`
		Attributes map[string]json.RawMessage `json:"attributes"`
		Body       string                     `json:"body"`
	}
	indexed := []string{"episode_id", "tenant_id", "event", "provider_session_id", "journey_id", "trace_id"}
	out := make([]row, 0, len(rows))
	for _, raw := range rows {
		var stored struct {
			Service    json.RawMessage `json:"service"`
			Attributes json.RawMessage `json:"attributes"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil {
			return nil, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(stored.Attributes, &fields); err != nil {
			return nil, err
		}
		wire := row{Service: stored.Service, Attributes: make(map[string]json.RawMessage), Body: "chalk-evidence-v2:" + string(stored.Attributes)}
		for _, key := range indexed {
			if value, exists := fields[key]; exists {
				wire.Attributes[key] = value
			}
		}
		out = append(out, wire)
	}
	return json.Marshal(out)
}

// EvidenceExport hands a batch of stored evidence rows to the place they are read from. A nil
// error means every row was taken; the relay deletes the rows only then.
type EvidenceExport func(ctx context.Context, rows []json.RawMessage) error

// RunEvidenceRelay drains ready groups into export and backs off between idle or failed reads.
func RunEvidenceRelay(ctx context.Context, relay func(context.Context, func(context.Context, []json.RawMessage) error) (int, error), export EvidenceExport, logger *slog.Logger) {
	for ctx.Err() == nil {
		count, err := relay(ctx, export)
		if count > 0 {
			continue
		}
		if err != nil && ctx.Err() == nil {
			// Neither HTTP responses nor driver errors are safe to print.
			logger.WarnContext(ctx, "Evidence relay did not complete; pending payloads retained", "event", "telemetry.relay_retry")
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}
