package whiteboardfiles

import (
	"log/slog"
	"time"

	files "github.com/q9labs/chalk/features/whiteboard/api/internal/files"
	"github.com/q9labs/chalk/features/whiteboard/api/internal/postgres"
	"github.com/q9labs/chalk/features/whiteboard/api/internal/sqlc"
)

type CleanupCycleRunner = files.CleanupCycleRunner
type CleanupScheduler = files.CleanupScheduler
type Subject = files.Subject
type Upload = files.Upload
type Download = files.Download
type Repository = files.Repository
type ObjectStore = files.ObjectStore
type Service = files.Service
type CleanupClaim = files.CleanupClaim
type CleanupClaimInput = files.CleanupClaimInput
type CleanupRepository = files.CleanupRepository
type ObjectDeleter = files.ObjectDeleter
type CleanupResult = files.CleanupResult
type CleanupWorker = files.CleanupWorker
type SyncParticipantVerifier = files.SyncParticipantVerifier
type ParticipantVerifier = files.ParticipantVerifier

var ErrInvalidInput = files.ErrInvalidInput
var ErrPermissionDenied = files.ErrPermissionDenied
var ErrFileNotFound = files.ErrFileNotFound
var ErrFileTransferFailed = files.ErrFileTransferFailed
var ErrCleanupLeaseLost = files.ErrCleanupLeaseLost

func NewService(repository Repository, objects ObjectStore) Service {
	return files.NewService(repository, objects)
}
func NewParticipantVerifier(verifier SyncParticipantVerifier) ParticipantVerifier {
	return files.NewParticipantVerifier(verifier)
}
func NewCleanupWorker(repository CleanupRepository, objects ObjectDeleter) CleanupWorker {
	return files.NewCleanupWorker(repository, objects)
}
func NewCleanupScheduler(worker CleanupCycleRunner, interval time.Duration, logger *slog.Logger) *CleanupScheduler {
	return files.NewCleanupScheduler(worker, interval, logger)
}
func NewWhiteboardFileRepository(db sqlc.DBTX) postgres.WhiteboardFileRepository {
	return postgres.NewWhiteboardFileRepository(db)
}
