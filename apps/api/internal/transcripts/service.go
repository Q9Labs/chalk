package transcripts

func NewService(repository Repository) Service {
	artifacts, _ := repository.(ArtifactRepository)
	cleanup, _ := repository.(CleanupRepository)
	finalizer, _ := repository.(FinalizerRepository)
	return Service{repository: repository, artifacts: artifacts, cleanup: cleanup, finalizer: finalizer}
}

func NewArtifactService(repository Repository, artifacts ArtifactRepository) Service {
	cleanup, _ := repository.(CleanupRepository)
	finalizer, _ := repository.(FinalizerRepository)
	return Service{repository: repository, artifacts: artifacts, cleanup: cleanup, finalizer: finalizer}
}

func (s Service) WithDispatcherWaker(waker DispatcherWaker) Service {
	s.waker = waker
	return s
}
