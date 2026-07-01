package email_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/email"
)

func TestServiceSendEmail(t *testing.T) {
	sender := &senderStub{
		result: email.SendEmailResult{ProviderMessageID: "email_123"},
	}
	service := email.NewService(sender)

	result, err := service.SendEmail(context.Background(), email.SendEmailInput{
		From:     " Chalk <updates@chalk.test> ",
		To:       []string{" user@chalk.test "},
		CC:       []string{"cc@chalk.test"},
		BCC:      []string{"bcc@chalk.test"},
		ReplyTo:  "support@chalk.test",
		Subject:  "  Welcome  ",
		TextBody: "Hello",
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
	if sender.input.From != "\"Chalk\" <updates@chalk.test>" {
		t.Fatalf("from = %q, want formatted address", sender.input.From)
	}
	if sender.input.To[0] != "user@chalk.test" {
		t.Fatalf("to = %#v, want trimmed recipient", sender.input.To)
	}
	if sender.input.Subject != "Welcome" {
		t.Fatalf("subject = %q, want Welcome", sender.input.Subject)
	}
	if sender.input.IdempotencyKey != "welcome:user@chalk.test" {
		t.Fatalf("idempotency key = %q, want welcome:user@chalk.test", sender.input.IdempotencyKey)
	}
}

func TestServiceRejectsInvalidInput(t *testing.T) {
	valid := email.SendEmailInput{
		From:     "updates@chalk.test",
		To:       []string{"user@chalk.test"},
		Subject:  "Welcome",
		TextBody: "Hello",
	}

	tests := []struct {
		name string
		edit func(*email.SendEmailInput)
		want error
	}{
		{
			name: "missing sender",
			edit: func(input *email.SendEmailInput) {
				input.From = ""
			},
			want: email.ErrInvalidSender,
		},
		{
			name: "missing recipient",
			edit: func(input *email.SendEmailInput) {
				input.To = nil
			},
			want: email.ErrInvalidRecipient,
		},
		{
			name: "invalid cc",
			edit: func(input *email.SendEmailInput) {
				input.CC = []string{"nope"}
			},
			want: email.ErrInvalidRecipient,
		},
		{
			name: "missing subject",
			edit: func(input *email.SendEmailInput) {
				input.Subject = " "
			},
			want: email.ErrInvalidSubject,
		},
		{
			name: "missing body",
			edit: func(input *email.SendEmailInput) {
				input.TextBody = " "
				input.HTMLBody = ""
			},
			want: email.ErrMissingBody,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := valid
			tt.edit(&input)

			_, err := email.NewService(&senderStub{}).SendEmail(context.Background(), input)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestServiceRejectsMissingSenderAdapter(t *testing.T) {
	_, err := email.NewService(nil).SendEmail(context.Background(), email.SendEmailInput{})
	if !errors.Is(err, email.ErrSenderUnavailable) {
		t.Fatalf("error = %v, want %v", err, email.ErrSenderUnavailable)
	}
}

type senderStub struct {
	input  email.SendEmailInput
	result email.SendEmailResult
	err    error
}

func (s *senderStub) SendEmail(_ context.Context, input email.SendEmailInput) (email.SendEmailResult, error) {
	s.input = input
	return s.result, s.err
}
