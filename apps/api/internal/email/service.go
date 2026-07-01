package email

import (
	"context"
	"errors"
	"net/mail"
	"strings"
)

var (
	ErrInvalidSender       = errors.New("invalid email sender")
	ErrInvalidRecipient    = errors.New("invalid email recipient")
	ErrInvalidSubject      = errors.New("invalid email subject")
	ErrMissingBody         = errors.New("missing email body")
	ErrSenderUnavailable   = errors.New("email sender unavailable")
	ErrProviderFailed      = errors.New("email provider failed")
	ErrProviderRateLimited = errors.New("email provider rate limited")
)

type Sender interface {
	SendEmail(ctx context.Context, input SendEmailInput) (SendEmailResult, error)
}

type Service struct {
	sender Sender
}

type SendEmailInput struct {
	From           string
	To             []string
	Subject        string
	TextBody       string
	HTMLBody       string
	CC             []string
	BCC            []string
	ReplyTo        string
	Headers        map[string]string
	Tags           []Tag
	IdempotencyKey string
}

type Tag struct {
	Name  string
	Value string
}

type SendEmailResult struct {
	ProviderMessageID string
}

func NewService(sender Sender) Service {
	return Service{sender: sender}
}

func (s Service) SendEmail(ctx context.Context, input SendEmailInput) (SendEmailResult, error) {
	if s.sender == nil {
		return SendEmailResult{}, ErrSenderUnavailable
	}
	if err := PrepareSendEmailInput(&input); err != nil {
		return SendEmailResult{}, err
	}

	return s.sender.SendEmail(ctx, input)
}

func PrepareSendEmailInput(input *SendEmailInput) error {
	from, err := prepareAddress(input.From)
	if err != nil {
		return ErrInvalidSender
	}
	input.From = from

	recipients, err := prepareAddressList(input.To)
	if err != nil {
		return ErrInvalidRecipient
	}
	input.To = recipients

	cc, err := prepareOptionalAddressList(input.CC)
	if err != nil {
		return ErrInvalidRecipient
	}
	input.CC = cc

	bcc, err := prepareOptionalAddressList(input.BCC)
	if err != nil {
		return ErrInvalidRecipient
	}
	input.BCC = bcc

	if input.ReplyTo != "" {
		replyTo, err := prepareAddress(input.ReplyTo)
		if err != nil {
			return ErrInvalidRecipient
		}
		input.ReplyTo = replyTo
	}

	subject := strings.TrimSpace(input.Subject)
	if subject == "" {
		return ErrInvalidSubject
	}
	input.Subject = subject

	if strings.TrimSpace(input.TextBody) == "" && strings.TrimSpace(input.HTMLBody) == "" {
		return ErrMissingBody
	}

	return nil
}

func prepareAddressList(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, ErrInvalidRecipient
	}

	return prepareOptionalAddressList(values)
}

func prepareOptionalAddressList(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}

	prepared := make([]string, 0, len(values))
	for _, value := range values {
		address, err := prepareAddress(value)
		if err != nil {
			return nil, err
		}
		prepared = append(prepared, address)
	}

	return prepared, nil
}

func prepareAddress(value string) (string, error) {
	address, err := mail.ParseAddress(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	if address.Name == "" {
		return address.Address, nil
	}

	return address.String(), nil
}
