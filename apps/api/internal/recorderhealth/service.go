package recorderhealth

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

var ErrPoolUnavailable = errors.New("recorder pool unavailable")

type Repository interface {
	GetPoolHealth(ctx context.Context, role recordingpipeline.PoolRole) (recordingpipeline.PoolHealth, error)
}

type Service struct {
	repository Repository
	maxAge     time.Duration
	now        func() time.Time
}

func NewService(repository Repository, maxAge time.Duration) Service {
	return Service{repository: repository, maxAge: maxAge, now: time.Now}
}

func (s Service) CheckRecorderPool(ctx context.Context, role workeridentity.Role) error {
	if s.repository == nil || s.maxAge <= 0 {
		return ErrPoolUnavailable
	}
	poolRole, err := recordingPoolRole(role)
	if err != nil {
		return err
	}
	health, err := s.repository.GetPoolHealth(ctx, poolRole)
	if err != nil || !health.AdmissionReady(s.now().UTC(), s.maxAge) {
		return ErrPoolUnavailable
	}
	return nil
}

func recordingPoolRole(role workeridentity.Role) (recordingpipeline.PoolRole, error) {
	switch role {
	case workeridentity.RoleCapture:
		return recordingpipeline.PoolRoleCapture, nil
	case workeridentity.RoleRender:
		return recordingpipeline.PoolRoleRender, nil
	default:
		return "", ErrPoolUnavailable
	}
}
