package presenting

import (
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func pagePrefix(tenantID, spaceID, episodeID, documentID utilities.ID, page int) string {
	return strings.Join([]string{
		"presenting-v1", "tenants", tenantID.String(), "episodes", episodeID.String(),
		"documents", documentID.String(), "pages", strconv.Itoa(page),
	}, "/")
}

func imageKey(tenantID, spaceID, episodeID, documentID utilities.ID, page int) string {
	return pagePrefix(tenantID, spaceID, episodeID, documentID, page) + "/1600.webp"
}

func thumbnailKey(tenantID, spaceID, episodeID, documentID utilities.ID, page int) string {
	return pagePrefix(tenantID, spaceID, episodeID, documentID, page) + "/240.webp"
}

func zoomKey(tenantID, spaceID, episodeID, documentID utilities.ID, page int) string {
	return pagePrefix(tenantID, spaceID, episodeID, documentID, page) + "/3200.webp"
}

func attemptPagePrefix(tenantID, spaceID, episodeID, documentID, jobID utilities.ID, attempt, page int) string {
	return strings.Join([]string{
		"presenting-v1", "tenants", tenantID.String(), "episodes", episodeID.String(),
		"documents", documentID.String(), "attempts", jobID.String(), strconv.Itoa(attempt), "pages", strconv.Itoa(page),
	}, "/")
}

func attemptImageKey(tenantID, spaceID, episodeID, documentID, jobID utilities.ID, attempt, page int) string {
	return attemptPagePrefix(tenantID, spaceID, episodeID, documentID, jobID, attempt, page) + "/1600.webp"
}

func attemptThumbnailKey(tenantID, spaceID, episodeID, documentID, jobID utilities.ID, attempt, page int) string {
	return attemptPagePrefix(tenantID, spaceID, episodeID, documentID, jobID, attempt, page) + "/240.webp"
}

func attemptZoomKey(tenantID, spaceID, episodeID, documentID, jobID utilities.ID, attempt, page int) string {
	return attemptPagePrefix(tenantID, spaceID, episodeID, documentID, jobID, attempt, page) + "/3200.webp"
}

func supportedMIMEType(value string) bool {
	switch value {
	case "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}
