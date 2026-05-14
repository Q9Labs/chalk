package ops

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

type TwilioClient struct {
	enabled    bool
	accountSID string
	authToken  string
	from       string
	client     *http.Client
	logger     *slog.Logger
}

func NewTwilioClient(cfg *config.Config, logger *slog.Logger) *TwilioClient {
	if logger == nil {
		logger = slog.Default()
	}
	return &TwilioClient{
		enabled:    cfg != nil && cfg.Ops.WhatsAppEnabled,
		accountSID: cfg.Ops.TwilioAccountSID,
		authToken:  cfg.Ops.TwilioAuthToken,
		from:       cfg.Ops.TwilioWhatsAppFrom,
		client:     &http.Client{Timeout: 20 * time.Second},
		logger:     logger.With("component", "ops_twilio"),
	}
}

func (c *TwilioClient) SendWhatsApp(ctx context.Context, to, body string) (string, error) {
	if !c.enabled {
		return "", nil
	}
	form := url.Values{}
	form.Set("To", normalizeWhatsAppAddress(to))
	form.Set("From", normalizeWhatsAppAddress(c.from))
	form.Set("Body", body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", c.accountSID), strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.accountSID+":"+c.authToken)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("twilio send failed: %s", strings.TrimSpace(string(bodyBytes)))
	}

	var payload struct {
		SID string `json:"sid"`
	}
	if err := json.Unmarshal(bodyBytes, &payload); err != nil {
		return "", nil
	}
	return payload.SID, nil
}

func normalizeWhatsAppAddress(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, "whatsapp:") {
		return v
	}
	return "whatsapp:" + v
}

func (s *Service) enqueueIncidentNotifications(ctx context.Context, incident db.OpsIncident, template, message string) {
	if s.config == nil || !s.config.Ops.WhatsAppEnabled {
		return
	}
	recipients := s.config.Ops.WhatsAppToMajor
	if incident.Severity == "critical" {
		recipients = append(recipients, s.config.Ops.WhatsAppToCritical...)
	}
	if len(recipients) == 0 {
		return
	}

	payload := metadataJSON(map[string]any{
		"incident_code": incident.IncidentCode,
		"title":         incident.Title,
		"message":       message,
		"status":        incident.Status,
		"severity":      incident.Severity,
	})
	for _, recipient := range recipients {
		recipient = strings.TrimSpace(recipient)
		if recipient == "" {
			continue
		}
		if _, err := s.queries.CreateOpsNotificationDelivery(ctx, db.CreateOpsNotificationDeliveryParams{
			IncidentID:  pgtype.UUID{Bytes: incident.ID, Valid: true},
			Channel:     "whatsapp",
			Recipient:   recipient,
			DedupeKey:   fmt.Sprintf("%s:%s", incident.IncidentCode, template),
			Template:    template,
			Status:      "pending",
			Provider:    "twilio",
			Payload:     payload,
			NextRetryAt: time.Now().UTC(),
		}); err != nil {
			s.logger.Warn("failed to enqueue ops notification", "incident_code", incident.IncidentCode, "recipient", recipient, "error", err)
		}
	}
}

func (s *Service) ProcessNotifications(ctx context.Context, limit int32) error {
	if limit <= 0 {
		limit = 20
	}
	deliveries, err := s.queries.ListPendingOpsNotificationDeliveries(ctx, limit)
	if err != nil {
		return err
	}
	for _, delivery := range deliveries {
		body := s.notificationBody(delivery)
		sid, err := s.httpClient.SendWhatsApp(ctx, delivery.Recipient, body)
		if err != nil {
			retryAt := time.Now().UTC().Add(time.Duration(delivery.Attempts+1) * time.Minute)
			if delivery.Attempts >= 4 {
				failErr := err.Error()
				if markErr := s.queries.MarkOpsNotificationFailed(ctx, db.MarkOpsNotificationFailedParams{
					ID:        delivery.ID,
					LastError: &failErr,
				}); markErr != nil {
					return markErr
				}
				continue
			}
			retryErr := err.Error()
			if markErr := s.queries.MarkOpsNotificationRetry(ctx, db.MarkOpsNotificationRetryParams{
				ID:          delivery.ID,
				LastError:   &retryErr,
				NextRetryAt: retryAt,
			}); markErr != nil {
				return markErr
			}
			continue
		}
		if err := s.queries.MarkOpsNotificationSent(ctx, db.MarkOpsNotificationSentParams{
			ID:                delivery.ID,
			ProviderMessageID: optionalString(sid),
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) notificationBody(delivery db.OpsNotificationDelivery) string {
	var payload struct {
		IncidentCode string `json:"incident_code"`
		Title        string `json:"title"`
		Message      string `json:"message"`
		Status       string `json:"status"`
		Severity     string `json:"severity"`
	}
	_ = json.Unmarshal(delivery.Payload, &payload)
	statusURL := ""
	if s.config != nil && strings.TrimSpace(s.config.Ops.PublicStatusBaseURL) != "" {
		statusURL = strings.TrimRight(s.config.Ops.PublicStatusBaseURL, "/")
	}
	return strings.TrimSpace(fmt.Sprintf("[%s] %s\n%s\nStatus: %s\n%s", strings.ToUpper(payload.Severity), payload.Title, payload.Message, payload.Status, statusURL))
}

func (s *Service) sendWorkerFallbackAlert(ctx context.Context, message string) error {
	if !s.config.Ops.WhatsAppEnabled {
		return nil
	}
	if len(s.config.Ops.WhatsAppToCritical) == 0 {
		return nil
	}
	_, err := s.httpClient.SendWhatsApp(ctx, s.config.Ops.WhatsAppToCritical[0], message)
	return err
}

func incidentUUID(id uuid.UUID) pgtype.UUID {
	return pgtype.UUID{Bytes: id, Valid: true}
}
