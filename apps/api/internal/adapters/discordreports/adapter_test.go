package discordreports

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"unicode/utf16"

	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"testing"
)

func TestWebhookDestinations(t *testing.T) {
	if client, err := NewAdapter(""); client != nil || err != nil {
		t.Fatal("an unset webhook must disable reporting without a configuration error")
	}
	for _, destination := range []string{
		"http://discord.com/api/webhooks/123/abc", "https://example.com/api/webhooks/123/abc",
		"https://discord.com.evil.test/api/webhooks/123/abc", "https://discord.com:444/api/webhooks/123/abc",
		"https://user@discord.com/api/webhooks/123/abc", "https://discord.com/not-a-webhook",
		"https://discord.com/api/webhooks/123/abc#fragment", "https://discord.com/%zz",
	} {
		if client, err := NewAdapter(destination); client != nil || err == nil {
			t.Errorf("accepted unsafe destination %q", destination)
		}
	}
	for _, host := range []string{"discord.com", "discordapp.com"} {
		if client, err := NewAdapter("https://" + host + "/api/webhooks/123/abc"); client == nil || err != nil {
			t.Errorf("rejected Discord host %s", host)
		}
	}
}

func TestKeepSchemelessText(t *testing.T) {
	for _, link := range []string{"example.com/reset?token=short", "discord.gg/invite", "//example.com/private", "EXAMPLE.COM/reset?secret=short", "file.js:12:5", "file.go:37"} {
		got := safeText("Camera failed at "+link+" again", 900)
		if got != "Camera failed at "+link+" again" {
			t.Errorf("ordinary text changed: %s", got)
		}
	}
}

type fixtureTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func TestDiscordPreservesAcceptedReporterName(t *testing.T) {
	for _, name := range []string{strings.Repeat("n", 251) + "TAILZ", strings.Repeat("_", 251) + "TAILZ", strings.Repeat("🎥", 63) + "ENDZ", "Alice\nReporter: Claimed owner" + strings.Repeat(" ", 227)} {
		t.Run(name[len(name)-4:], func(t *testing.T) {
			var content string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Content string `json:"content"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				content = payload.Content
				w.WriteHeader(200)
			}))
			defer server.Close()
			target, err := url.Parse(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			adapter, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
			if err != nil {
				t.Fatal(err)
			}
			adapter.client.Transport = fixtureTransport{target, http.DefaultTransport}
			if len([]byte(name)) != 256 {
				t.Fatal("fixture must reach the accepted byte ceiling")
			}
			if err := adapter.Send(context.Background(), problemreports.Delivery{Attribution: problemreports.Attribution{SpaceName: "Call", ReporterName: name, Role: "guest"}, Report: problemreports.Report{Description: strings.Repeat("x", 1000)}}); err != nil {
				t.Fatal(err)
			}
			if len(utf16.Encode([]rune(content))) > 2000 {
				t.Fatal("content exceeds Discord ceiling")
			}
			if !strings.Contains(strings.ReplaceAll(content, `\_`, "_"), "Reporter: "+strings.Join(strings.Fields(name), " ")+" (guest)") {
				t.Error("accepted reporter name lost its suffix")
			}
			if strings.Contains(content, "\nReporter: Claimed owner") {
				t.Error("reporter name injected an attribution line")
			}
			if !strings.Contains(content, "Episode ID:") || strings.Contains(content, "Call ID:") {
				t.Fatal("noncanonical identifier label")
			}
		})
	}
}

func TestDiscordPreservesSupportedSpaceName(t *testing.T) {
	for _, name := range []string{strings.Repeat("n", 116) + "TAIL", strings.Repeat("🎥", 116) + "TAIL", strings.Repeat("_", 116) + "TAIL"} {
		var content string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var payload struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			content = payload.Content
			w.WriteHeader(http.StatusOK)
		}))
		adapter, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
		if err != nil {
			t.Fatal(err)
		}
		target, err := url.Parse(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		adapter.client.Transport = fixtureTransport{target, http.DefaultTransport}
		if err := adapter.Send(context.Background(), problemreports.Delivery{Attribution: problemreports.Attribution{SpaceName: name, ReporterName: strings.Repeat("n", 256), Role: "owner"}, Report: problemreports.Report{Description: strings.Repeat("x", 1000), Diagnostics: strings.Repeat("d", 2000)}}); err != nil {
			t.Fatal(err)
		}
		server.Close()
		if !strings.Contains(content, "Call: "+markdown.Replace(name)+"\nEpisode ID:") {
			t.Error("supported Space name lost its suffix in final payload")
		}
		if len(utf16.Encode([]rune(content))) > 2000 {
			t.Fatal("Discord content limit exceeded")
		}
	}
}

func TestDiscordDeliversFullAcceptedText(t *testing.T) {
	var content string
	var panels []struct {
		Description string `json:"description"`
	}
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Content string `json:"content"`
			Embeds  []struct {
				Description string `json:"description"`
			} `json:"embeds"`
			AllowedMentions struct {
				Parse []string `json:"parse"`
			} `json:"allowed_mentions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		content, panels = payload.Content, payload.Embeds
		posts++
		if len(utf16.Encode([]rune(content))) > 2000 || payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
			t.Error("invalid Discord content or mention guards")
		}
		units := 0
		for _, panel := range panels {
			size := len(utf16.Encode([]rune(panel.Description)))
			if size > 4096 {
				t.Error("Discord embed description limit exceeded")
			}
			units += size
		}
		if units > 6000 {
			t.Error("combined Discord embed limit exceeded")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
	if err != nil {
		t.Fatal(err)
	}
	client.client.Transport = fixtureTransport{target, http.DefaultTransport}
	for _, fixture := range []struct {
		name, description, diagnostics, wantDescription, wantDiagnostics string
	}{
		{"ascii", strings.Repeat("x", 990) + "ENDMARKERZ", "", strings.Repeat("x", 990) + "ENDMARKERZ", ""},
		{"astral", strings.Repeat("🎥", 999) + "Z", "", strings.Repeat("🎥", 999) + "Z", ""},
		{"all_markdown", strings.Repeat("#", 1000), strings.Repeat("*", 2000), strings.Repeat(`\#`, 1000), strings.Repeat(`\*`, 2000)},
		{"full_diagnostics", "Could not connect", strings.Repeat("🎥", 1999) + "Z", "Could not connect", strings.Repeat("🎥", 1999) + "Z"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			before := posts
			if err := client.Send(context.Background(), problemreports.Delivery{Report: problemreports.Report{Description: fixture.description, Diagnostics: fixture.diagnostics}, Attribution: problemreports.Attribution{SpaceName: "New Call", ReporterName: "Tester", Role: "guest"}}); err != nil {
				t.Fatal(err)
			}
			if posts != before+1 {
				t.Fatal("one report must use exactly one acknowledged Discord POST")
			}
			description, diagnostics := "", ""
			if len(panels) > 0 {
				description = panels[0].Description
				if len(panels) > 1 {
					diagnostics = panels[1].Description
				}
			} else {
				_, description, _ = strings.Cut(content, "\n\nDescription:\n")
				description, diagnostics, _ = strings.Cut(description, "\n\nDiagnostics:\n")
			}
			if description != fixture.wantDescription || diagnostics != fixture.wantDiagnostics {
				t.Fatal("accepted report text was silently truncated in the final Discord payload")
			}
		})
	}
}

func (t fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.URL.Scheme, clone.URL.Host = t.target.Scheme, t.target.Host
	return t.base.RoundTrip(clone)
}

func TestDiscordWebhookDelivery(t *testing.T) {
	var bodies []string
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Query().Get("wait") != "true" {
			t.Error("missing acknowledged webhook POST")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		bodies = append(bodies, string(body))
		w.WriteHeader(status)
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
	if err != nil {
		t.Fatal(err)
	}
	client.client.Transport = fixtureTransport{target, http.DefaultTransport}
	callID, err := utilities.ParseID("55555555-5555-4555-8555-555555555555")
	if err != nil {
		t.Fatal(err)
	}
	report := problemreports.Delivery{
		Report:      problemreports.Report{Description: "Camera failed @everyone person@example.com حسن@مثال.مصر \"quoted name\"@example.com https://chalk.test/space/invite-secret Bearer hidden-secret token=private-value example.com/reset?token=short discord.gg/invite", Diagnostics: "Connection: failed\nLast error: media.failed\nBrowser: Test Browser\nApp version: 1.0"},
		Attribution: problemreports.Attribution{SpaceName: "New Call", ReporterName: "Tester person@example.com", Role: "guest"}, CallID: callID,
	}
	if err := client.Send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Content         string `json:"content"`
		AllowedMentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
	}
	if err := json.Unmarshal([]byte(bodies[0]), &payload); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"New Call", callID.String(), "Tester", "(guest)", "Camera failed", "Connection: failed", "Last error: media.failed", "Browser: Test Browser", "App version: 1.0"} {
		if !strings.Contains(payload.Content, field) {
			t.Errorf("missing field %s", field)
		}
	}
	for _, private := range []string{"Tenant:", "UTC:", "report_id"} {
		if strings.Contains(bodies[0], private) {
			t.Error("private data reached Discord")
		}
	}
	if payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
		t.Fatal("mentions not disabled")
	}
	report.Diagnostics = ""
	if err := client.Send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(bodies[len(bodies)-1], "Diagnostics:") {
		t.Fatal("diagnostics opt-out lost")
	}
	report.Description, report.Diagnostics = strings.Repeat("🎥", 1000), strings.Repeat("🎥", 2000)
	if err := client.Send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(bodies[len(bodies)-1]), &payload); err != nil {
		t.Fatal(err)
	}
	if len(utf16.Encode([]rune(payload.Content))) > 2000 {
		t.Fatal("Discord limit exceeded")
	}
	for _, code := range []int{http.StatusInternalServerError, http.StatusFound} {
		status = code
		err := client.Send(context.Background(), report)
		var failure problemreports.DeliveryError
		if !errors.Is(err, problemreports.ErrDelivery) || !errors.As(err, &failure) || failure.HTTPStatus != code {
			t.Fatalf("bounded delivery status not propagated for %d", code)
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	deliveryErr := client.Send(canceled, report)
	if !errors.Is(deliveryErr, problemreports.ErrDelivery) || !strings.Contains(deliveryErr.Error(), "canceled") || strings.Contains(deliveryErr.Error(), "https://") {
		t.Fatal("transport cause must be bounded and redact destination")
	}
}

func TestDiscordPayloadPreservesLiteralText(t *testing.T) {
	credential := strings.Repeat("sensitive", 8)
	splitCredential := strings.Join([]string{credential[:24], credential[24:48], credential[48:]}, "<")
	var content string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		content = payload.Content
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
	if err != nil {
		t.Fatal(err)
	}
	client.client.Transport = fixtureTransport{target, http.DefaultTransport}
	text := "[Reconnect](ht<tps://attacker.xyz) " + splitCredential + " user<@example.com **urgent**"
	if err := client.Send(context.Background(), problemreports.Delivery{
		Report:      problemreports.Report{Description: text, Diagnostics: text},
		Attribution: problemreports.Attribution{SpaceName: text, ReporterName: text, Role: "guest"},
	}); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"https://attacker.xyz", credential, "user@example.com", "**urgent**", "[Reconnect]("} {
		if strings.Contains(content, private) {
			t.Errorf("unsafe text in final Discord payload: %q", private)
		}
	}
	if !strings.Contains(content, `\[Reconnect\]`) || !strings.Contains(content, `\*\*urgent\*\*`) {
		t.Fatal("user Markdown was not escaped in the final payload")
	}
	if !strings.Contains(content, strings.ReplaceAll(splitCredential, "<", `\<`)) {
		t.Fatal("unknown text was removed from the final payload")
	}
	for _, text := range []string{
		"See https://example.org/help?private=query#fragment.",
		"See www.example.org/help?private=query#fragment.",
		strings.Repeat("a", 880) + " https://example.org/long/path?private=query#fragment",
		"`https://example.org/help?private=query#fragment`",
	} {
		if err := client.Send(context.Background(), problemreports.Delivery{Report: problemreports.Report{Description: text}}); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(content, "private=query") || strings.Contains(content, "fragment") {
			t.Fatal("URL query or fragment reached the final payload")
		}
		// User backticks are escaped; every emitted URL span must close, even at the cap.
		unescaped := strings.ReplaceAll(content, "\\`", "")
		if strings.Count(unescaped, "`") != 2 {
			t.Fatal("URL code span is unbalanced in the final payload")
		}
	}
}

func TestDiscordPreservesLegacySpaceName(t *testing.T) {
	var payload struct {
		Content string `json:"content"`
	}
	var attached string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attached = ""
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if err := json.Unmarshal([]byte(r.FormValue("payload_json")), &payload); err != nil {
				t.Error(err)
			}
			file, _, err := r.FormFile("files[0]")
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			data, err := io.ReadAll(file)
			if err != nil {
				t.Error(err)
			}
			attached = string(data)
		} else if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := NewAdapter("https://discord.com/api/webhooks/test/fake")
	if err != nil {
		t.Fatal(err)
	}
	adapter.client.Transport = fixtureTransport{target, http.DefaultTransport}
	for _, length := range []int{121, 256, 4096} {
		name := strings.Repeat("_", length-5) + "TAILZ"
		err := adapter.Send(context.Background(), problemreports.Delivery{Attribution: problemreports.Attribution{SpaceName: name, Role: "owner"}, Report: problemreports.Report{Description: "Camera froze"}})
		if err != nil {
			t.Fatal(err)
		}
		want := strings.Repeat(`\_`, length-5) + "TAILZ"
		if !strings.Contains(payload.Content, want) && attached != want {
			t.Fatal("legacy Space name lost its identifying suffix")
		}
		if len(utf16.Encode([]rune(payload.Content))) > 2000 {
			t.Fatal("Discord content limit exceeded")
		}
	}
}
