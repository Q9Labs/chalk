package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var errFeedbackAuditUnavailable = errors.New("feedback access audit is unavailable")

type feedbackAuditCreator interface {
	Create(context.Context, auditlogs.CreateInput) (auditlogs.AuditLog, error)
}

type feedbackAuditWriter struct {
	service feedbackAuditCreator
}

func NewFeedbackAuditWriter(service feedbackAuditCreator) FeedbackAuditWriter {
	return feedbackAuditWriter{service: service}
}

func (w feedbackAuditWriter) RecordFeedbackRead(ctx context.Context, tenantID, reportID utilities.ID, operation, outcome string) error {
	if w.service == nil || tenantID.IsZero() || reportID.IsZero() {
		return errFeedbackAuditUnavailable
	}
	details, err := json.Marshal(map[string]string{"operation": operation, "outcome": outcome})
	if err != nil {
		return err
	}
	resourceType := "feedback_report"
	_, err = w.service.Create(ctx, auditlogs.CreateInput{TenantID: tenantID, ActorType: auditlogs.ActorOperator, Action: "feedback." + operation, ResourceType: &resourceType, ResourceID: reportID, Details: details, Outcome: outcome})
	return err
}

var _ FeedbackAuditWriter = feedbackAuditWriter{}
