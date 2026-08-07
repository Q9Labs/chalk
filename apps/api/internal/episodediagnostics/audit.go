package episodediagnostics

import (
	"context"
	"encoding/json"

	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AuditLogCreator interface {
	Create(context.Context, auditlogs.CreateInput) (auditlogs.AuditLog, error)
}

type AuditLogWriter struct {
	service AuditLogCreator
}

func NewAuditLogWriter(service AuditLogCreator) AuditLogWriter {
	return AuditLogWriter{service: service}
}

func (w AuditLogWriter) WriteDiagnosticAudit(ctx context.Context, diagnostic EpisodeDiagnostic, operator OperatorPrincipal, capability, outcomeValue, errorCode string) error {
	if w.service == nil {
		return nil
	}
	tenantID, err := utilities.ParseID(diagnostic.TenantID)
	if err != nil {
		return err
	}
	resourceID, err := utilities.ParseID(diagnostic.ID)
	if err != nil {
		return err
	}
	details, err := json.Marshal(map[string]string{
		"operator_hash": operator.SubjectHash,
		"capability":    capability,
		"environment":   string(operator.Environment),
	})
	if err != nil {
		return err
	}
	resourceType := "episode_diagnostic"
	var auditErrorCode *string
	if errorCode != "" {
		auditErrorCode = &errorCode
	}
	_, err = w.service.Create(ctx, auditlogs.CreateInput{
		TenantID:     tenantID,
		ActorType:    auditlogs.ActorOperator,
		Action:       "episode_diagnostic." + capability,
		ResourceType: &resourceType,
		ResourceID:   resourceID,
		Details:      details,
		Outcome:      outcomeValue,
		ErrorCode:    auditErrorCode,
	})
	return err
}
