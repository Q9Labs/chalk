package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AuditLogRepository struct {
	queries auditLogQuerier
}

type auditLogQuerier interface {
	CreateAuditLog(ctx context.Context, arg sqlc.CreateAuditLogParams) (sqlc.AuditLog, error)
	GetTenantAuditLog(ctx context.Context, arg sqlc.GetTenantAuditLogParams) (sqlc.AuditLog, error)
	ListTenantAuditLogs(ctx context.Context, arg sqlc.ListTenantAuditLogsParams) ([]sqlc.AuditLog, error)
}

func NewAuditLogRepository(queries auditLogQuerier) AuditLogRepository {
	return AuditLogRepository{queries: queries}
}

func (r AuditLogRepository) Create(ctx context.Context, input auditlogs.CreateInput) (auditlogs.AuditLog, error) {
	log, err := r.queries.CreateAuditLog(ctx, sqlc.CreateAuditLogParams{
		ID:           uuid(input.ID),
		TenantID:     uuid(input.TenantID),
		ActorUserID:  uuid(input.ActorUserID),
		ActorType:    input.ActorType,
		Action:       input.Action,
		Details:      jsonBytes(input.Details),
		Outcome:      input.Outcome,
		ErrorCode:    text(input.ErrorCode),
		ErrorMessage: text(input.ErrorMessage),
		Before:       jsonBytes(input.Before),
		After:        jsonBytes(input.After),
	})
	if err != nil {
		return auditlogs.AuditLog{}, fmt.Errorf("create audit log: %w", err)
	}

	return mapAuditLog(log), nil
}

func (r AuditLogRepository) Get(ctx context.Context, tenantID utilities.ID, auditLogID utilities.ID) (auditlogs.AuditLog, error) {
	log, err := r.queries.GetTenantAuditLog(ctx, sqlc.GetTenantAuditLogParams{
		TenantID: uuid(tenantID),
		ID:       uuid(auditLogID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return auditlogs.AuditLog{}, auditlogs.ErrAuditLogNotFound
	}
	if err != nil {
		return auditlogs.AuditLog{}, fmt.Errorf("get audit log: %w", err)
	}

	return mapAuditLog(log), nil
}

func (r AuditLogRepository) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (auditlogs.AuditLogList, error) {
	rows, err := r.queries.ListTenantAuditLogs(ctx, listTenantAuditLogsParams(tenantID, page))
	if err != nil {
		return auditlogs.AuditLogList{}, fmt.Errorf("list audit logs: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := auditlogs.AuditLogList{
		AuditLogs: make([]auditlogs.AuditLog, 0, len(rows)),
		Page:      pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		list.AuditLogs = append(list.AuditLogs, mapAuditLog(row))
	}
	if hasMore && len(list.AuditLogs) > 0 {
		last := list.AuditLogs[len(list.AuditLogs)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func listTenantAuditLogsParams(tenantID utilities.ID, page pagination.PageRequest) sqlc.ListTenantAuditLogsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantAuditLogsParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func mapAuditLog(log sqlc.AuditLog) auditlogs.AuditLog {
	return auditlogs.AuditLog{
		ID:           utilities.IDFromBytes(log.ID.Bytes),
		TenantID:     utilities.IDFromBytes(log.TenantID.Bytes),
		ActorUserID:  nullableID(log.ActorUserID),
		ActorType:    log.ActorType,
		Action:       log.Action,
		Details:      jsonRaw(log.Details),
		Outcome:      log.Outcome,
		ErrorCode:    nullableText(log.ErrorCode),
		ErrorMessage: nullableText(log.ErrorMessage),
		Before:       jsonRaw(log.Before),
		After:        jsonRaw(log.After),
		UpdatedAt:    timestamp(log.UpdatedAt),
		CreatedAt:    timestamp(log.CreatedAt),
	}
}

var _ auditlogs.Repository = AuditLogRepository{}
