package publicinvites

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) CreateAutoLifecycle(ctx context.Context, lifecycle AutoLifecycle) (AutoLifecycle, error) {
	if err := validateIDs(lifecycle.TenantID, lifecycle.SpaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if lifecycle.DeadlineAt.IsZero() || lifecycle.RetryCount < 0 {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if lifecycle.State != "" && lifecycle.State != AutoLifecycleActive {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if lifecycle.NextRetryAt != nil || lifecycle.ArchiveCompletedAt != nil || lifecycle.LastErrorFamily != "" {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	lifecycle.State = AutoLifecycleActive
	return s.lifecycleCreate(ctx, lifecycle)
}

func (s Service) GetAutoLifecycle(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.GetAutoLifecycle(ctx, tenantID, spaceID)
}

func (s Service) DueAutoLifecycles(ctx context.Context, now time.Time, pageSize int32) ([]AutoLifecycle, error) {
	if now.IsZero() {
		now = s.now()
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	if s.lifecycle == nil {
		return nil, ErrLifecycleUnavailable
	}
	return s.lifecycle.ListDueAutoLifecycles(ctx, now, pageSize)
}

func (s Service) MarkAutoLifecycleArchiving(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.MarkAutoLifecycleArchiving(ctx, tenantID, spaceID)
}

func (s Service) MarkAutoLifecycleArchived(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.MarkAutoLifecycleArchived(ctx, tenantID, spaceID)
}

func (s Service) RetryAutoLifecycle(ctx context.Context, input RetryAutoLifecycleInput) (AutoLifecycle, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if input.NextRetryAt.IsZero() || !validErrorFamily(input.ErrorFamily) {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.RetryAutoLifecycle(ctx, input)
}

func (s Service) lifecycleCreate(ctx context.Context, lifecycle AutoLifecycle) (AutoLifecycle, error) {
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.CreateAutoLifecycle(ctx, lifecycle)
}
