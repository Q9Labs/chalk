package resend

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	resendsdk "github.com/resend/resend-go/v3"

	"github.com/q9labs/chalk/apps/api/internal/email"
)

func TestSenderUsesResendSDKForResetAndInvitation(t *testing.T) {
	for _, key := range []string{"", "invitation-id"} {
		t.Run("idempotency="+key, func(t *testing.T) {
			for _, status := range []int{http.StatusOK, http.StatusBadRequest, http.StatusTooManyRequests} {
				t.Run(http.StatusText(status), func(t *testing.T) {
					var logs bytes.Buffer
					previousLogger := slog.Default()
					slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
					t.Cleanup(func() { slog.SetDefault(previousLogger) })
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path != "/emails" || r.Header.Get("Idempotency-Key") != key {
							t.Errorf("unexpected email request path or idempotency key")
						}
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(status)
						if status == http.StatusOK {
							_, _ = w.Write([]byte(`{"id":"message-id"}`))
							return
						}
						_, _ = w.Write([]byte(`{"message":"rejected private@example.test token=private-token"}`))
					}))
					defer server.Close()
					client := resendsdk.NewCustomClient(server.Client(), "test-key")
					var err error
					client.BaseURL, err = url.Parse(server.URL + "/")
					if err != nil {
						t.Fatal(err)
					}
					result, err := newSender(client.Emails).SendEmail(context.Background(), email.SendEmailInput{
						From: "sender@example.test", To: []string{"private@example.test"}, Subject: "Account email",
						TextBody: "https://example.test/#token=private-token", IdempotencyKey: key,
					})
					if status == http.StatusOK {
						if err != nil || result.ProviderMessageID != "message-id" || logs.Len() != 0 {
							t.Fatalf("successful delivery result=%v error=%v logs=%s", result, err, &logs)
						}
						return
					}
					want := email.ErrProviderFailed
					if status == http.StatusTooManyRequests {
						want = email.ErrProviderRateLimited
					}
					if !errors.Is(err, want) || !strings.Contains(logs.String(), "email.delivery.failed") {
						t.Fatalf("provider failure error=%v logs=%s", err, &logs)
					}
					for _, private := range []string{"private@example.test", "private-token", "sender@example.test", "test-key", "invitation-id"} {
						if strings.Contains(logs.String(), private) {
							t.Fatalf("email failure log leaked private input")
						}
					}
				})
			}
		})
	}
}
