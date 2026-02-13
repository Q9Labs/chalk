package email

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type ResendClient struct {
	apiKey string
	from   string
	client *http.Client
}

func NewResendClient(apiKey, from string) *ResendClient {
	return &ResendClient{
		apiKey: apiKey,
		from:   from,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

type resendSendEmailRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html,omitempty"`
	Text    string   `json:"text,omitempty"`
}

// SendMagicLink sends a basic magic-link email via Resend.
func (c *ResendClient) SendMagicLink(ctx context.Context, to, link string) error {
	if c == nil || c.apiKey == "" || c.from == "" {
		return fmt.Errorf("resend not configured")
	}

	body, err := json.Marshal(resendSendEmailRequest{
		From:    c.from,
		To:      []string{to},
		Subject: "Your Chalk sign-in link",
		Text:    fmt.Sprintf("Sign in to Chalk:\n\n%s\n\nIf you didn't request this email, you can ignore it.", link),
		HTML: fmt.Sprintf(
			`<p>Sign in to Chalk:</p><p><a href="%s">%s</a></p><p>If you didn't request this email, you can ignore it.</p>`,
			link, link,
		),
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("resend send failed: status=%d", resp.StatusCode)
	}

	return nil
}

