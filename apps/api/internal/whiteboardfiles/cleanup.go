package whiteboardfiles

import (
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var cleanupKind = objectcleanup.Kind{
	Name:  "whiteboard_files",
	Label: "whiteboard file",
	Scope: "github.com/q9labs/chalk/apps/api/internal/whiteboardfiles",
}

type CleanupClaim struct {
	UploadID  utilities.ID
	ObjectKey string
	Token     utilities.ID
}

func NewCleanupWorker(repository objectcleanup.Repository[CleanupClaim], objects objectcleanup.ObjectDeleter) objectcleanup.Worker[CleanupClaim] {
	return objectcleanup.NewWorker(cleanupKind, repository, objects, func(claim CleanupClaim) string { return claim.ObjectKey })
}
