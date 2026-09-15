package recordingpreparation

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	PreparationWindow = 5 * time.Minute
	NoShowGrace       = 5 * time.Minute
)

var (
	ErrInvalidInput = errors.New("invalid recording preparation")
	ErrNotFound     = errors.New("recording preparation not found")
	ErrConflict     = errors.New("recording preparation revision conflict")
	ErrPolicyDenied = errors.New("recording preparation denied by Space policy")
)

type State string

const (
	Scheduled State = "scheduled"
	Warming   State = "warming"
	Ready     State = "ready"
	Consumed  State = "consumed"
	Canceled  State = "canceled"
	Expired   State = "expired"
)

type Preparation struct {
	TenantID          utilities.ID
	SpaceID           utilities.ID
	StartsAt          time.Time
	State             State
	Revision          int64
	CapacityAvailable bool
	Ready             bool
	UpdatedAt         time.Time
}

type Input struct {
	TenantID         utilities.ID
	SpaceID          utilities.ID
	StartsAt         time.Time
	ExpectedRevision int64
}

type Repository interface {
	Prepare(context.Context, Input, time.Time) (Preparation, error)
	Cancel(context.Context, Input, time.Time) (Preparation, error)
	Get(context.Context, utilities.ID, utilities.ID, time.Time) (Preparation, error)
}

func (p Preparation) At(now time.Time) Preparation {
	if p.State != Scheduled {
		p.Ready = false
		return p
	}
	if !now.Before(p.StartsAt.Add(NoShowGrace)) {
		p.State, p.Ready = Expired, false
		return p
	}
	if now.Before(p.StartsAt.Add(-PreparationWindow)) {
		p.Ready = false
		return p
	}
	p.State = Warming
	if p.Ready && p.CapacityAvailable {
		p.State = Ready
	}
	return p
}
