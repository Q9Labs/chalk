package recordinglifecycle

import (
	"context"
	"fmt"
	"time"
)

type Clock func() time.Time

type Service struct {
	repository Repository
	now        Clock
}

func NewService(repository Repository, now Clock) (Service, error) {
	if repository == nil {
		return Service{}, ErrRepositoryUnavailable
	}
	if now == nil {
		now = time.Now
	}
	return Service{repository: repository, now: now}, nil
}

func (s Service) PublishReady(ctx context.Context, input ReadyInput) (Publication, error) {
	if s.repository == nil {
		return Publication{}, ErrRepositoryUnavailable
	}
	if err := validateReadyInput(input, s.now()); err != nil {
		return Publication{}, err
	}
	publication, err := s.repository.PublishReady(ctx, input)
	if err != nil {
		return Publication{}, fmt.Errorf("publish recording capture ready: %w", err)
	}
	return publication, nil
}

func (s Service) PublishStopped(ctx context.Context, input StoppedInput) (Publication, error) {
	if s.repository == nil {
		return Publication{}, ErrRepositoryUnavailable
	}
	if err := validateStoppedInput(input, s.now()); err != nil {
		return Publication{}, err
	}
	publication, err := s.repository.PublishStopped(ctx, input)
	if err != nil {
		return Publication{}, fmt.Errorf("publish recording capture stopped: %w", err)
	}
	return publication, nil
}
