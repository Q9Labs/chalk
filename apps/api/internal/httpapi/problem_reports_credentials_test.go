package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

type reportKnownCredentials []string

func (values reportKnownCredentials) Credentials(context.Context, accessgrants.Subject) ([]string, error) {
	return values, nil
}

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

func TestProblemReportCredentialRejection(t *testing.T) {
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
	signer, err := publicinvites.NewSigner(publicinvites.Keyring{CurrentKeyID: "test", Signer: private, Verifiers: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	_, invite, err := signer.IssueRandom(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Verify(invite); err != nil {
		t.Fatal("invalid invite fixture")
	}
	if _, err := verifier.Verify(context.Background(), proof.Token); err != nil {
		t.Fatal("invalid media fixture")
	}
	otherSubject := subject
	otherSubject.ParticipantGeneration++
	otherProof, err := issuer.Issue(context.Background(), otherSubject)
	if err != nil {
		t.Fatal(err)
	}
	knownOpaque := reportKnownCredentials{invite, strings.Repeat("gQ7_zP2-", 10), strings.Repeat("ab09", 20), strings.Repeat("qwertyuiop", 16)}
	const session = "reportersessionopaquevalue"
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
	var carriedCookies []*http.Cookie
	var carriedAuthorizations []string
	var carriedCSRF string
	attribution := problemreports.Attribution{SpaceName: "New Call", ReporterName: "Tester", Role: "guest"}
	post := func(report problemreports.Report) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(report)
		if err != nil {
			t.Fatal(err)
		}
		repository := reportCredentialAttribution{reportAttributionRepository{subject}, attribution}
		router := NewRouter(Options{ProblemReports: problemreports.NewService(repository, adapter).WithCredentials(knownOpaque), ParticipantMediaVerify: verifier, RateLimit: DefaultRateLimitOptions()})
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", strings.NewReader(string(body)))
		request.Header.Set("Authorization", "Bearer "+proof.Token)
		request.AddCookie(&http.Cookie{Name: "__Host-chalk_session", Value: session})
		for _, cookie := range carriedCookies {
			request.AddCookie(cookie)
		}
		for _, authorization := range carriedAuthorizations {
			request.Header.Add("Authorization", authorization)
		}
		if carriedCSRF != "" {
			request.Header.Set("X-CSRF-Token", carriedCSRF)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
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
	t.Run("every_request_credential_kind", func(t *testing.T) {
		// Opaque cookie values deliberately have no public token-format prefix.
		mac := hmac.New(sha256.New, private)
		_, _ = mac.Write([]byte("chalk/public-invite/guest-credential/v1"))
		guest := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		type credentialCase struct{ name, value, cookie, authorization string }
		cases := []credentialCase{
			{name: "participant_media_bearer", value: proof.Token},
			{name: "bound_signed_invite", value: invite},
			{name: "additional_bearer", value: guest, authorization: "Bearer " + guest},
			{name: "native_guest_authorization", value: guest, authorization: publicGuestScheme + " " + guest},
			{name: "guest_first_arrival", value: guest, cookie: publicGuestCookiePrefix + "first-arrival"},
			{name: "guest_second_arrival", value: guest, cookie: publicGuestCookiePrefix + "second-arrival"},
			{name: "csrf_header", value: guest},
		}
		// cookieName in the web auth layer owns these namespaces; covering every
		// purpose also includes future seat IDs rather than a four-cookie allowlist.
		for _, prefix := range []string{"__Host-chalk_", "local_chalk_"} {
			for _, purpose := range []string{"session", "binding", "login_google", "login_apple", "seat_first", "seat_second"} {
				cases = append(cases, credentialCase{name: prefix + purpose, value: guest, cookie: prefix + purpose})
			}
		}
		for _, fixture := range cases {
			for _, field := range []string{"description", "diagnostics"} {
				t.Run(fixture.name+"/"+field, func(t *testing.T) {
					if fixture.cookie != "" {
						carriedCookies = []*http.Cookie{{Name: fixture.cookie, Value: fixture.value}}
					}
					if fixture.authorization != "" {
						carriedAuthorizations = []string{fixture.authorization}
					}
					if fixture.name == "csrf_header" {
						carriedCSRF = fixture.value
					}
					defer func() { carriedCookies = nil; carriedAuthorizations = nil; carriedCSRF = "" }()
					report := problemreports.Report{Description: "The call stopped working."}
					if field == "description" {
						report.Description += " " + fixture.value
					} else {
						report.Diagnostics = fixture.value
					}
					before := len(payloads)
					response := post(report)
					if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "reports.credentials_detected") || len(payloads) != before {
						t.Fatalf("request credential reached Discord: status=%d deliveries=%d", response.Code, len(payloads)-before)
					}
				})
			}
		}
	})
	t.Run("credential_shapes", func(t *testing.T) {
		for _, secret := range []string{"https://DISCORD.com/api/webhooks/123456789012345678/" + strings.Repeat("MiXeD_", 8), "https://user@otlp.example", "postgres://u:p@h/db", strings.Join([]string{"eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", strings.Repeat("s", 43)}, "."), "AKIA" + strings.Repeat("A1", 8), "postgres://unrelated:unconfigured-password@public.example/db", "https://user:any-password@example.org/help", "redis://user:p%40ssword@public.example/0", "//user:password@example.org/path"} {
			for _, field := range []string{"description", "diagnostics"} {
				report := problemreports.Report{Description: "The call stopped working."}
				if field == "description" {
					report.Description += " " + secret
				} else {
					report.Diagnostics = secret
				}
				before := len(payloads)
				response := post(report)
				if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "reports.credentials_detected") || len(payloads) != before {
					t.Fatalf("password reached final Discord payload: field=%s status=%d deliveries=%d", field, response.Code, len(payloads)-before)
				}
			}
		}
	})
	t.Run("holder_reconstruction_across_unrelated_fields_is_out_of_scope", func(t *testing.T) {
		previous := attribution
		defer func() { attribution = previous }()
		for name, credential := range map[string]string{"invite": invite, "media": proof.Token} {
			t.Run(name, func(t *testing.T) {
				attribution.SpaceName = credential[:20]
				attribution.ReporterName = "Ordinary reporter"
				var pieces []string
				for start := 20; start < len(credential); start += 8 {
					pieces = append(pieces, credential[start:min(start+8, len(credential))])
				}
				description := strings.Join(pieces, " ")
				before := len(payloads)
				response := post(problemreports.Report{Description: description})
				if response.Code != http.StatusOK || len(payloads) != before+1 {
					t.Fatalf("deliberate holder reconstruction changed scope: status=%d", response.Code)
				}
				final := strings.ReplaceAll(payloads[before], `\_`, "_")
				if !strings.Contains(final, attribution.SpaceName) || !strings.Contains(final, attribution.ReporterName) || !strings.Contains(final, description) {
					t.Fatal("scope fixture did not retain the deliberately separated credential pieces")
				}
				reconstructed := attribution.SpaceName + strings.ReplaceAll(description, " ", "")
				if reconstructed != credential {
					t.Fatal("fixture does not reconstruct the exact live credential")
				}
				if name == "invite" {
					if _, err := signer.Verify(reconstructed); err != nil {
						t.Fatal("reconstructed scope fixture is not a valid signed invite")
					}
				} else if _, err := verifier.Verify(context.Background(), reconstructed); err != nil {
					t.Fatal("reconstructed scope fixture is not a valid media credential")
				}
			})
		}
	})
	t.Run("known_credential_punctuation", func(t *testing.T) {
		secrets := []string{strings.Repeat("!", 32), "a" + strings.Repeat("!", 31), strings.Repeat("a-", 16) + "._", strings.Repeat("+", 32)}
		previous := knownOpaque
		knownOpaque = append(append(reportKnownCredentials(nil), knownOpaque...), secrets...)
		defer func() { knownOpaque = previous }()
		for _, description := range []string{"I cannot hear the other person after reconnecting.", "a", strings.Repeat("a", 16)} {
			before := len(payloads)
			if response := post(problemreports.Report{Description: description}); response.Code != http.StatusOK || len(payloads) != before+1 {
				t.Errorf("known credential punctuation falsely blocked ordinary text: status=%d", response.Code)
			}
		}
		for _, secret := range secrets {
			knownOpaque = append(append(reportKnownCredentials(nil), previous...), secret)
			for _, split := range []bool{false, true} {
				report := problemreports.Report{Description: secret}
				if split {
					report.Description = secret[:20]
					var pieces []string
					for start := 20; start < len(secret); start += 2 {
						pieces = append(pieces, secret[start:min(start+2, len(secret))])
					}
					report.Diagnostics = strings.Join(pieces, " \u200b+")
				}
				before := len(payloads)
				response := post(report)
				if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "reports.credentials_detected") || len(payloads) != before {
					t.Errorf("known punctuation-bearing credential reached Discord: status=%d deliveries=%d", response.Code, len(payloads)-before)
				}
			}
		}
	})

	t.Run("cross_field_live_and_formats", func(t *testing.T) {
		for _, credential := range []string{invite, proof.Token, knownOpaque[1], knownOpaque[2], session, "ghp_aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ"} {
			var chunks []string
			for start := 20; start < len(credential); start += 8 {
				chunks = append(chunks, credential[start:min(start+8, len(credential))])
			}
			before := len(payloads)
			response := post(problemreports.Report{Description: credential[:20], Diagnostics: strings.Join(chunks, " ")})
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "reports.credentials_detected") || len(payloads) != before {
				t.Errorf("cross-field credential reached Discord: status=%d deliveries=%d", response.Code, len(payloads)-before)
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
	type wrapping struct {
		name, separator string
		interval        int
	}
	wrappings := []wrapping{
		{"plain", "", 20}, {"angle", "<", 20}, {"zero_width_1", "\u200b", 1},
		{"word_joiner", "\u2060", 20}, {"variation_selector", "\ufe0f", 20}, {"backtick", "`", 20}, {"comma", ",", 20}, {"full_width", "", 0},
	}
	for interval := 2; interval <= 31; interval++ {
		for name, separator := range map[string]string{"zero_width": "\u200b", "space": " ", "newline": "\n", "entity": "&#9;", "punctuation": ":;"} {
			wrappings = append(wrappings, wrapping{fmt.Sprintf("%s_%d", name, interval), separator, interval})
		}
	}
	for name, credential := range map[string]string{"signed_invite": invite, "participant_media": proof.Token, "other_participant_jwt": otherProof.Token, "known_base64url": knownOpaque[1], "known_hex": knownOpaque[2], "known_alphabet_only": knownOpaque[3], "session": session, "webhook": "https://discord.com/api/webhooks/test/fake", "chalk_api_key": strings.Join([]string{"chalk_sk_AbCd01234567", "aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ0abCDefGhI"}, ".")} {
		for _, fixture := range wrappings {
			t.Run(name+"/"+fixture.name, func(t *testing.T) {
				var text strings.Builder
				for index, character := range credential {
					if fixture.interval == 0 {
						if character >= '!' && character <= '~' {
							character += 0xfee0
						}
					} else if index > 0 && index%fixture.interval == 0 {
						text.WriteString(fixture.separator)
					}
					text.WriteRune(character)
				}
				// The media JWT plus one separator per byte exceeds the description cap,
				// so exercise the larger opt-in diagnostics field for that fixture too.
				report := problemreports.Report{Description: "Could not connect to the call."}
				if utf8.RuneCountInString(text.String())+len("Please reconnect: ") <= problemreports.MaxDescriptionCodePoints {
					report.Description = "Please reconnect: " + text.String()
				} else {
					report.Diagnostics = text.String()
				}
				before := len(payloads)
				response := post(report)
				oversized := utf8.RuneCountInString(report.Diagnostics) > problemreports.MaxDiagnosticsCodePoints
				if response.Code != http.StatusBadRequest || !oversized && (!strings.Contains(response.Body.String(), "reports.credentials_detected") || !strings.Contains(response.Body.String(), "Remove links and codes")) {
					t.Errorf("expected actionable credential rejection; status=%d", response.Code)
				}
				if len(payloads) != before {
					t.Error("credential-bearing report reached the final Discord HTTP payload")
				}
				if utf8.RuneCountInString(text.String()) <= problemreports.MaxDiagnosticsCodePoints {
					response = post(problemreports.Report{Description: "Could not connect", Diagnostics: text.String()})
					if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "reports.credentials_detected") {
						t.Errorf("diagnostics credential not rejected: status=%d", response.Code)
					}
					if len(payloads) != before {
						t.Error("credential diagnostics reached the final Discord payload")
					}
				}
			})
		}
	}
	unknown := "J7mQ2vL9xR4bT6kW0zN3cF8hP1sD5gY_aV-UeZoIXqC"
	for chunk := 2; chunk <= 31; chunk++ {
		for _, separator := range []string{"\" + \"", "\"\n\""} {
			var pieces []string
			for start := 0; start < len(unknown); start += chunk {
				pieces = append(pieces, unknown[start:min(start+chunk, len(unknown))])
			}
			description := "Call failed: \"" + strings.Join(pieces, separator) + "\""
			before := len(payloads)
			response := post(problemreports.Report{Description: description})
			if response.Code != http.StatusOK || len(payloads) != before+1 {
				t.Fatalf("unknown code expression refused at chunk %d", chunk)
			}
			if !strings.Contains(strings.ReplaceAll(payloads[before], `\_`, "_"), description) {
				t.Fatal("unknown code expression changed in the final payload")
			}
		}
	}
	beforeFormats := len(payloads)
	customHeaderJWT := strings.Join([]string{base64.RawURLEncoding.EncodeToString([]byte(`{"jku":"https://example.org/keys","alg":"HS256"}`)), "eyJzdWIiOiJmaXh0dXJlIn0", "signaturefixturebyteshere"}, ".")
	for _, publicFormat := range []string{strings.Join([]string{"eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "signaturefixturebyteshere"}, "."), customHeaderJWT, "sk_" + "live_" + "aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ", "pk_" + "test_" + "aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ", "ghp_aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ", "github_pat_aB9xD2fG4hJ6kL8mN0pQ2rS4tV6wX8yZ", "AKIA0123456789ABCDEF", "-----BEGIN PRIVATE KEY-----"} {
		for _, code := range []string{publicFormat, "\"" + strings.Join(strings.Split(publicFormat, ""), "\" + \"") + "\""} {
			response := post(problemreports.Report{Description: code})
			if response.Code != http.StatusBadRequest {
				t.Fatal("public format or contiguous opaque code accepted")
			}
		}
	}
	if len(payloads) != beforeFormats {
		t.Fatal("rejected code reached final Discord payload")
	}
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
