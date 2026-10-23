package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
)

type reportCredentialAttribution struct {
	reportAttributionRepository
	attribution problemreports.Attribution
}

func (r reportCredentialAttribution) Attribution(ctx context.Context, subject accessgrants.Subject) (problemreports.Attribution, error) {
	if _, err := r.reportAttributionRepository.Attribution(ctx, subject); err != nil {
		return problemreports.Attribution{}, err
	}
	return r.attribution, nil
}

// Route the real Discord client to a local final-payload capture, not a fake service.
type reportCredentialTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (transport reportCredentialTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.URL.Scheme, clone.URL.Host = transport.target.Scheme, transport.target.Host
	return transport.base.RoundTrip(clone)
}

func TestProblemReportPayload(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "report-test", KeyID: "test", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "report-test", VerificationKeys: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	subject := participantMediaSubject(t)
	proof, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	var payloads []string
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
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
			t.Error("mentions enabled")
		}
		text := payload.Content
		for _, embed := range payload.Embeds {
			text += "\n" + embed.Description
		}
		payloads = append(payloads, text)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	original := http.DefaultTransport
	http.DefaultTransport = reportCredentialTransport{target, original}
	defer func() { http.DefaultTransport = original }()
	adapter, err := discordreports.NewAdapter("https://discord.com/api/webhooks/test/fake")
	if err != nil {
		t.Fatal(err)
	}
	attribution := problemreports.Attribution{SpaceName: "New Call", ReporterName: "Tester", Role: "guest"}
	post := func(report problemreports.Report) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(report)
		if err != nil {
			t.Fatal(err)
		}
		repository := reportCredentialAttribution{reportAttributionRepository{subject}, attribution}
		router := NewRouter(Options{ProblemReports: problemreports.NewService(repository, adapter), ParticipantMediaVerify: verifier, RateLimit: DefaultRateLimitOptions()})
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", strings.NewReader(string(body)))
		request.Header.Set("Authorization", "Bearer "+proof.Token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	t.Run("ordinary_webhook_prose", func(t *testing.T) {
		for _, report := range []problemreports.Report{
			{Description: "I looked at discord.com/api/webhooks but the camera still froze."},
			{Description: "Camera froze.", Diagnostics: "I looked at discord.com/api/webhooks but the camera still froze."},
		} {
			before := len(payloads)
			response := post(report)
			if response.Code != http.StatusOK || len(payloads) != before+1 {
				t.Fatalf("ordinary prose refused: status=%d", response.Code)
			}
		}
	})
	t.Run("client_text_and_listed_metadata_only", func(t *testing.T) {
		// Environment values and server error text must never be appended to delivery.
		t.Setenv("PGPASSWORD", "provider-database-only-value")
		t.Setenv("AWS_SECRET_ACCESS_KEY", "provider-aws-only-value")
		t.Setenv("AWS_SESSION_TOKEN", "provider-session-only-value")
		for _, report := range []problemreports.Report{
			{Description: "Camera froze."},
			{Description: "Camera froze.", Diagnostics: "Connection: failed\nBrowser: Local browser"},
		} {
			before := len(payloads)
			response := post(report)
			if response.Code != http.StatusOK || len(payloads) != before+1 {
				t.Fatalf("report boundary failed: status=%d", response.Code)
			}
			want := "Chalk problem report\nCall: New Call\nEpisode ID: " + subject.EpisodeID.String() + "\nReporter: Tester (guest)\n\nDescription:\n" + report.Description
			if report.Diagnostics != "" {
				want += "\n\nDiagnostics:\n" + report.Diagnostics
			}
			if payloads[before] != want {
				t.Error("Discord added text outside client fields and approved metadata")
			}
		}
	})
	t.Run("literal_final_payload", func(t *testing.T) {
		nodeStack, err := os.ReadFile("testdata/report-node-typeerror.txt")
		if err != nil {
			t.Fatal(err)
		}
		taskStack, err := os.ReadFile("testdata/report-task-typeerror.txt")
		if err != nil {
			t.Fatal(err)
		}
		// Capture a real Go test stack, keeping its first two source frames within the report cap.
		goStack := strings.Join(strings.Split(string(debug.Stack()), "\n")[:5], "\n")
		const commit = "2a97b528908e7697de4d732262a72cc5a4f1c9d2"
		cases := []struct {
			name, text, diagnostics string
			wanted                  []string
			absent                  []string
		}{
			{name: "node_task_function", text: strings.TrimSpace(string(taskStack)), wanted: []string{"task_refresh_connection_state_after_reconnect", "function-stack.js:1:110", "loader:1956:14"}},
			{name: "task_function_prose", text: "The task_refresh_connection_state_after_reconnect function failed.", wanted: []string{"The task_refresh_connection_state_after_reconnect function failed."}},
			{name: "node_typeerror", text: strings.TrimSpace(string(nodeStack)), wanted: []string{"stack-sample.js:1:62", "stack-sample.js:2:7", "loader:1956:14"}},
			{name: "go_test_stack", text: goStack, wanted: []string{goStack}},
			{name: "commit_sha", text: "The call failed on commit " + commit, wanted: []string{commit}},
			{name: "full_ascii_fields", text: strings.Repeat("x", 990) + "ENDMARKERZ", diagnostics: strings.Repeat("d", 1990) + "DIAGMARKER", wanted: []string{strings.Repeat("x", 990) + "ENDMARKERZ", strings.Repeat("d", 1990) + "DIAGMARKER"}},
			{name: "full_astral_fields", text: strings.Repeat("🎥", 999) + "Z", diagnostics: strings.Repeat("🎥", 1999) + "Z", wanted: []string{strings.Repeat("🎥", 999) + "Z", strings.Repeat("🎥", 1999) + "Z"}},
			{name: "commit_url", text: "See https://github.com/Q9Labs/chalk/commit/" + commit, wanted: []string{"`https://github.com/Q9Labs/chalk/commit/" + commit + "`"}},
			{name: "url_query_fragment", text: "See https://example.org/help?session=unknown-private-code#private-fragment and www.example.org/guide?code=other#section", wanted: []string{"`https://example.org/help`", "`www.example.org/guide`"}, absent: []string{"unknown-private-code", "private-fragment", "?session", "?code", "#section"}},
			{name: "bare_host_frame_email_and_unknown_code", text: "file.js:12:5 main.go:23 example.com/path token=unknown-code contact@example.com " + strings.Repeat("a0b1", 10), wanted: []string{"file.js:12:5", "main.go:23", "example.com/path", "token=unknown-code", "contact@example.com", strings.Repeat("a0b1", 10)}},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				before := len(payloads)
				response := post(problemreports.Report{Description: tc.text, Diagnostics: tc.diagnostics})
				if response.Code != http.StatusOK || len(payloads) != before+1 {
					t.Fatalf("ordinary report not delivered: status=%d", response.Code)
				}
				final := payloads[len(payloads)-1]
				// Discord displays escaped Markdown as literal punctuation, not as formatting.
				visible := strings.NewReplacer(`\_`, "_", `\(`, "(", `\)`, ")", `\[`, "[", `\]`, "]").Replace(final)
				for _, want := range tc.wanted {
					if !strings.Contains(visible, want) {
						t.Errorf("final payload lost expected %s content", tc.name)
					}
				}
				for _, absent := range tc.absent {
					if strings.Contains(final, absent) {
						t.Errorf("URL query or fragment reached final payload")
					}
				}
			})
		}
	})
	for _, description := range []string{
		"I cannot hear the other participant after 2 minutes",
		"The other person could see and hear me but I could not hear them and the sound never came back even after I left the call and joined again so I had to ask them to use another call service to finish our meeting",

		"Could not connect to New Call. The camera preview was working before I joined, but the call stayed on the connecting screen. I tried again and had the same problem.",
		"The help page https://example.org/help did not fix the camera. @everyone [Reconnect](ht<tps://attacker.xyz)",
		"TEST from Chalk report-discord PR, ignore: owner",
		"Pneumonoultramicroscopicsilicovolcanoconiosis is a long word, not a call credential. The call microphone stopped working.",
		"TypeError: Cannot read property camera\n    at connect (/src/components/call-connection.ts:82:14)\n    at async Promise.all (index 0)",
		"The public guide at https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API did not fix the microphone.",
	} {
		t.Run(fmt.Sprintf("ordinary_%d", len(description)), func(t *testing.T) {
			before := len(payloads)
			response := post(problemreports.Report{Description: description, Diagnostics: "Connection: failed\nLast error: access.unavailable\nApp version: 1.0.0\nBrowser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"})
			if response.Code != http.StatusOK || len(payloads) != before+1 {
				t.Fatalf("ordinary report not delivered: status=%d", response.Code)
			}
			final := payloads[len(payloads)-1]
			if strings.Contains(final, "[Reconnect](") || strings.Contains(final, "https://attacker.xyz") {
				t.Error("final payload contains active Markdown or a reconstructed URL")
			}
		})
	}
}

type rejectingReportVerifier struct{ calls int }

func (v *rejectingReportVerifier) Verify(context.Context, string) (accessgrants.Subject, error) {
	v.calls++
	return accessgrants.Subject{}, accessgrants.ErrInvalidSignature
}

func TestProblemReportIPBeforeVerification(t *testing.T) {
	verifier := &rejectingReportVerifier{}
	handler := NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{}, &reportTestSender{}), ParticipantMediaVerify: verifier, RateLimit: DefaultRateLimitOptions()})
	for index := 0; index < 31; index++ {
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/problem-reports", strings.NewReader(`{"description":"Could not connect"}`))
		request.Header.Set("Authorization", "Bearer forged.header.signature")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		want := http.StatusUnauthorized
		if index == 30 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("attempt %d status=%d want=%d", index+1, response.Code, want)
		}
	}
	if verifier.calls != 30 {
		t.Fatalf("signature verification calls=%d want=30", verifier.calls)
	}
}

func TestProblemReportInternalErrorContract(t *testing.T) {
	for _, contract := range PreviewRouteContracts() {
		if contract.OperationID != "sendProblemReport" {
			continue
		}
		for _, failure := range contract.Errors {
			if failure == apiErrorInternal {
				return
			}
		}
		t.Fatal("report route omits its real internal-server failure")
	}
	t.Fatal("missing report route")
}
