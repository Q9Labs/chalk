package resend

import (
	"context"
	"errors"
	"testing"

	resendsdk "github.com/resend/resend-go/v3"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/email"
)

func TestNewSenderRejectsMissingAPIKey(t *testing.T) {
	_, err := NewSender(config.ResendConfig{APIKey: " ", Timeout: config.DefaultResendTimeout})
	if !errors.Is(err, ErrMissingAPIKey) {
		t.Fatalf("error = %v, want %v", err, ErrMissingAPIKey)
	}
}

func TestSenderSendEmail(t *testing.T) {
	client := &emailClientStub{
		response: &resendsdk.SendEmailResponse{Id: "email_123"},
	}
	sender := newSender(client)

	result, err := sender.SendEmail(context.Background(), email.SendEmailInput{
		From:     "updates@chalk.test",
		To:       []string{"user@chalk.test"},
		Subject:  "Welcome",
		TextBody: "Plain",
		HTMLBody: "<p>Plain</p>",
		CC:       []string{"cc@chalk.test"},
		BCC:      []string{"bcc@chalk.test"},
		ReplyTo:  "support@chalk.test",
		Headers: map[string]string{
			"X-Chalk-Category": "welcome",
		},
		Tags: []email.Tag{
			{Name: "tenant_id", Value: "tenant_123"},
		},
		IdempotencyKey: "welcome:user@chalk.test",
	})
	if err != nil {
		t.Fatalf("send email: %v", err)
	}

	if result.ProviderMessageID != "email_123" {
		t.Fatalf("provider message id = %q, want email_123", result.ProviderMessageID)
	}
	if client.request.From != "updates@chalk.test" {
		t.Fatalf("from = %q, want updates@chalk.test", client.request.From)
	}
	if client.request.To[0] != "user@chalk.test" {
		t.Fatalf("to = %#v, want user@chalk.test", client.request.To)
	}
	if client.request.Text != "Plain" {
		t.Fatalf("text = %q, want Plain", client.request.Text)
	}
	if client.request.Html != "<p>Plain</p>" {
		t.Fatalf("html = %q, want <p>Plain</p>", client.request.Html)
	}
	if client.request.Headers["X-Chalk-Category"] != "welcome" {
		t.Fatalf("headers = %#v, want category header", client.request.Headers)
	}
	if len(client.request.Tags) != 1 || client.request.Tags[0].Name != "tenant_id" || client.request.Tags[0].Value != "tenant_123" {
		t.Fatalf("tags = %#v, want tenant tag", client.request.Tags)
	}
	if client.options == nil || client.options.IdempotencyKey != "welcome:user@chalk.test" {
		t.Fatalf("options = %#v, want idempotency key", client.options)
	}
}

func TestSenderMapsProviderErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want error
	}{
		{
			name: "rate limit",
			err:  &resendsdk.RateLimitError{Message: "too many requests"},
			want: email.ErrProviderRateLimited,
		},
		{
			name: "provider failure",
			err:  errors.New("provider down"),
			want: email.ErrProviderFailed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sender := newSender(&emailClientStub{err: tt.err})

			_, err := sender.SendEmail(context.Background(), email.SendEmailInput{})
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
			if !errors.Is(err, tt.err) {
				t.Fatalf("error = %v, want wrapped provider error", err)
			}
		})
	}
}

func TestSenderRejectsMissingProviderMessageID(t *testing.T) {
	sender := newSender(&emailClientStub{response: &resendsdk.SendEmailResponse{}})

	_, err := sender.SendEmail(context.Background(), email.SendEmailInput{})
	if !errors.Is(err, email.ErrProviderFailed) {
		t.Fatalf("error = %v, want %v", err, email.ErrProviderFailed)
	}
}

type emailClientStub struct {
	request  *resendsdk.SendEmailRequest
	options  *resendsdk.SendEmailOptions
	response *resendsdk.SendEmailResponse
	err      error
}

func (c *emailClientStub) SendWithOptions(_ context.Context, params *resendsdk.SendEmailRequest, options *resendsdk.SendEmailOptions) (*resendsdk.SendEmailResponse, error) {
	c.request = params
	c.options = options
	return c.response, c.err
}
