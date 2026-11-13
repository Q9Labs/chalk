package discordreports

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type capturedRequest struct {
	method      string
	query       string
	contentType string
	body        []byte
}

type sentPayload struct {
	Content     string `json:"content"`
	Embeds      []struct{ Description string }
	Attachments []struct {
		ID       int
		Filename string
	}
	AllowedMentions struct{ Parse []string } `json:"allowed_mentions"`
}

func testDelivery(t *testing.T, name, description, diagnostics string) problemreports.Delivery {
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return problemreports.Delivery{
		Report:      problemreports.Report{Description: description, Diagnostics: diagnostics},
		Attribution: problemreports.Attribution{SpaceName: name, ReporterName: "  Ann   Lee ", Role: "host"},
		CallID:      id,
	}
}

func send(t *testing.T, status int, report problemreports.Delivery) (capturedRequest, error) {
	var captured capturedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured = capturedRequest{method: r.Method, query: r.URL.RawQuery, contentType: r.Header.Get("Content-Type"), body: body}
		w.WriteHeader(status)
	}))
	defer server.Close()
	adapter := &Adapter{webhookURL: server.URL + "/api/webhooks/1/token", client: server.Client()}
	err := adapter.Send(context.Background(), report)
	return captured, err
}

func TestSendInlineMessage(t *testing.T) {
	report := testDelivery(t, " My   Space ", "hello_world", "")
	captured, err := send(t, http.StatusOK, report)
	if err != nil {
		t.Fatal(err)
	}
	if captured.method != http.MethodPost || captured.query != "wait=true" || captured.contentType != "application/json" {
		t.Fatalf("unexpected request %+v", captured)
	}
	var payload sentPayload
	if err := json.Unmarshal(captured.body, &payload); err != nil {
		t.Fatal(err)
	}
	want := "Chalk problem report\nCall: My Space\nEpisode ID: " + report.CallID.String() + "\nReporter: Ann Lee (host)\n\nDescription:\nhello\\_world"
	if payload.Content != want || len(payload.Embeds) != 0 || len(payload.Attachments) != 0 || payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
		t.Fatalf("unexpected payload %+v", payload)
	}
	if !strings.Contains(string(captured.body), `"allowed_mentions":{"parse":[]}`) {
		t.Fatalf("allowed mentions not empty: %s", captured.body)
	}

	report = testDelivery(t, "S", "d", "diag")
	captured, err = send(t, http.StatusNoContent, report)
	if err != nil {
		t.Fatal(err)
	}
	payload = sentPayload{}
	if err := json.Unmarshal(captured.body, &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(payload.Content, "\n\nDescription:\nd\n\nDiagnostics:\ndiag") || len(payload.Embeds) != 0 {
		t.Fatalf("unexpected payload %+v", payload)
	}
}

func TestSendPanelsForLongContent(t *testing.T) {
	description := strings.Repeat("a", 1000)
	diagnostics := strings.Repeat("b", 1500)
	report := testDelivery(t, "S", description, diagnostics)
	captured, err := send(t, http.StatusOK, report)
	if err != nil {
		t.Fatal(err)
	}
	var payload sentPayload
	if err := json.Unmarshal(captured.body, &payload); err != nil {
		t.Fatal(err)
	}
	want := "Chalk problem report\nCall: S\nEpisode ID: " + report.CallID.String() + "\nReporter: Ann Lee (host)\n\nReport panels: description, then diagnostics when provided."
	if payload.Content != want || len(payload.Embeds) != 2 || payload.Embeds[0].Description != description || payload.Embeds[1].Description != diagnostics {
		t.Fatalf("unexpected payload %+v", payload)
	}

	report = testDelivery(t, "S", strings.Repeat("a", 1900), "")
	captured, err = send(t, http.StatusOK, report)
	if err != nil {
		t.Fatal(err)
	}
	payload = sentPayload{}
	if err := json.Unmarshal(captured.body, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Embeds) != 1 {
		t.Fatalf("embeds = %d", len(payload.Embeds))
	}
}

func TestSendAttachesLongSpaceName(t *testing.T) {
	name := strings.Repeat("n", 3000)
	report := testDelivery(t, name, "d", "")
	captured, err := send(t, http.StatusOK, report)
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, err := mime.ParseMediaType(captured.contentType)
	if err != nil || mediaType != "multipart/form-data" {
		t.Fatalf("content type %q: %v", captured.contentType, err)
	}
	reader := multipart.NewReader(strings.NewReader(string(captured.body)), params["boundary"])
	parts := map[string]string{}
	filenames := map[string]string{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(part)
		parts[part.FormName()] = string(data)
		filenames[part.FormName()] = part.FileName()
	}
	if parts["files[0]"] != name || filenames["files[0]"] != "call-name.txt" {
		t.Fatalf("unexpected file part %q %q", parts["files[0]"], filenames["files[0]"])
	}
	var payload sentPayload
	if err := json.Unmarshal([]byte(parts["payload_json"]), &payload); err != nil {
		t.Fatal(err)
	}
	want := "Chalk problem report\nCall: See call-name.txt\nEpisode ID: " + report.CallID.String() + "\nReporter: Ann Lee (host)\n\nDescription:\nd"
	if payload.Content != want || len(payload.Attachments) != 1 || payload.Attachments[0].ID != 0 || payload.Attachments[0].Filename != "call-name.txt" {
		t.Fatalf("unexpected payload %+v", payload)
	}
}

func TestSendStatusFailure(t *testing.T) {
	for _, status := range []int{300, 404, 500} {
		_, err := send(t, status, testDelivery(t, "S", "d", ""))
		var failure problemreports.DeliveryError
		if !errors.As(err, &failure) || failure.HTTPStatus != status || failure.Transport != 0 {
			t.Fatalf("status %d: error = %v", status, err)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type timeoutError struct{}

func (timeoutError) Error() string   { return "timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return false }

func TestSendTransportFailures(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want problemreports.TransportFailure
	}{
		{"unknown", errors.New("https://discord.com/api/webhooks/1/secret"), problemreports.TransportFailed},
		{"canceled", context.Canceled, problemreports.TransportCanceled},
		{"timeout", timeoutError{}, problemreports.TransportTimeout},
		{"dns", &net.DNSError{Err: "no such host"}, problemreports.TransportDNS},
		{"tls", &tls.CertificateVerificationError{}, problemreports.TransportTLS},
		{"connection", &net.OpError{Op: "dial"}, problemreports.TransportConnection},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, tc.err })}
			adapter := &Adapter{webhookURL: "https://discord.com/api/webhooks/1/token", client: client}
			err := adapter.Send(context.Background(), testDelivery(t, "S", "d", ""))
			var failure problemreports.DeliveryError
			if !errors.As(err, &failure) || failure.Transport != tc.want || failure.HTTPStatus != 0 {
				t.Fatalf("error = %#v, want transport %d", err, tc.want)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatalf("error leaks destination: %v", err)
			}
		})
	}
}

func TestSendRejectsUnparsableWebhook(t *testing.T) {
	adapter := &Adapter{webhookURL: "://bad", client: http.DefaultClient}
	if err := adapter.Send(context.Background(), testDelivery(t, "S", "d", "")); !errors.Is(err, problemreports.ErrDelivery) {
		t.Fatalf("error = %v", err)
	}
}
