package chatattachments

import (
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var cleanupKind = objectcleanup.Kind{
	Name:  "chat_attachments",
	Label: "chat attachment",
	Scope: "github.com/q9labs/chalk/apps/api/internal/chatattachments",
}

type CleanupClaim struct {
	TenantID     utilities.ID
	EpisodeID    utilities.ID
	AttachmentID utilities.ID
	ObjectKey    string
	Token        utilities.ID
}

func NewCleanupWorker(repository objectcleanup.Repository[CleanupClaim], objects objectcleanup.ObjectDeleter) objectcleanup.Worker[CleanupClaim] {
	return objectcleanup.NewWorker(cleanupKind, repository, objects, func(claim CleanupClaim) string { return claim.ObjectKey })
}
