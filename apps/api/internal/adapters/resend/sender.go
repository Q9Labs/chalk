package resend

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	resendsdk "github.com/resend/resend-go/v3"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/email"
)

var ErrMissingAPIKey = errors.New("missing resend api key")

type emailClient interface {
	SendWithOptions(ctx context.Context, params *resendsdk.SendEmailRequest, options *resendsdk.SendEmailOptions) (*resendsdk.SendEmailResponse, error)
}

type Sender struct {
	emails emailClient
}

func NewSender(cfg config.ResendConfig) (Sender, error) {
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		return Sender{}, ErrMissingAPIKey
	}

	httpClient := &http.Client{Timeout: cfg.Timeout}
	client := resendsdk.NewCustomClient(httpClient, apiKey)
	return newSender(client.Emails), nil
}

func newSender(emails emailClient) Sender {
	return Sender{emails: emails}
}

func (s Sender) SendEmail(ctx context.Context, input email.SendEmailInput) (email.SendEmailResult, error) {
	if s.emails == nil {
		return email.SendEmailResult{}, email.ErrSenderUnavailable
	}

	response, err := s.emails.SendWithOptions(ctx, sendEmailRequest(input), sendEmailOptions(input))
	if errors.Is(err, resendsdk.ErrRateLimit) {
		return email.SendEmailResult{}, fmt.Errorf("send resend email: %w", errors.Join(email.ErrProviderRateLimited, err))
	}
	if err != nil {
		return email.SendEmailResult{}, fmt.Errorf("send resend email: %w", errors.Join(email.ErrProviderFailed, err))
	}
	if response == nil || strings.TrimSpace(response.Id) == "" {
		return email.SendEmailResult{}, fmt.Errorf("send resend email: %w", email.ErrProviderFailed)
	}

	return email.SendEmailResult{ProviderMessageID: response.Id}, nil
}

func sendEmailRequest(input email.SendEmailInput) *resendsdk.SendEmailRequest {
	return &resendsdk.SendEmailRequest{
		From:    input.From,
		To:      input.To,
		Subject: input.Subject,
		Bcc:     input.BCC,
		Cc:      input.CC,
		ReplyTo: input.ReplyTo,
		Html:    input.HTMLBody,
		Text:    input.TextBody,
		Headers: input.Headers,
		Tags:    sendEmailTags(input.Tags),
	}
}

func sendEmailOptions(input email.SendEmailInput) *resendsdk.SendEmailOptions {
	if strings.TrimSpace(input.IdempotencyKey) == "" {
		return nil
	}

	return &resendsdk.SendEmailOptions{IdempotencyKey: input.IdempotencyKey}
}

func sendEmailTags(tags []email.Tag) []resendsdk.Tag {
	if len(tags) == 0 {
		return nil
	}

	mapped := make([]resendsdk.Tag, 0, len(tags))
	for _, tag := range tags {
		mapped = append(mapped, resendsdk.Tag{
			Name:  tag.Name,
			Value: tag.Value,
		})
	}

	return mapped
}

var _ email.Sender = Sender{}
