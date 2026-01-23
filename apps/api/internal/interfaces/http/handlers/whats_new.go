package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/github"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/gin-gonic/gin"
)

const whatsNewCacheKey = "whats-new:latest"

// WhatsNewHandler handles the What's New endpoint
type WhatsNewHandler struct {
	githubClient *github.Client
	redisClient  *redis.Client
	storageR2    storage.StorageClient
	cacheTTL     time.Duration
}

// WhatsNewResponse is the API response for What's New
type WhatsNewResponse struct {
	Version     string `json:"version"`
	PublishedAt string `json:"published_at"`
	Title       string `json:"title"`
	Content     string `json:"content"`
	ImageURL    string `json:"image_url,omitempty"`
}

// NewWhatsNewHandler creates a new WhatsNewHandler
func NewWhatsNewHandler(
	githubClient *github.Client,
	redisClient *redis.Client,
	storageR2 storage.StorageClient,
	cacheTTLMinutes int,
) *WhatsNewHandler {
	return &WhatsNewHandler{
		githubClient: githubClient,
		redisClient:  redisClient,
		storageR2:    storageR2,
		cacheTTL:     time.Duration(cacheTTLMinutes) * time.Minute,
	}
}

// Get handles GET /api/v1/whats-new
func (h *WhatsNewHandler) Get(c *gin.Context) {
	ctx := c.Request.Context()

	// Try cache first
	cached, err := h.getFromCache(ctx)
	if err == nil && cached != nil {
		c.JSON(http.StatusOK, cached)
		return
	}

	// Fetch from GitHub
	release, err := h.githubClient.GetLatestRelease(ctx)
	if err != nil {
		if errors.Is(err, github.ErrNoRelease) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no releases found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to fetch release info"})
		return
	}

	// Build response with presigned image URL if needed
	response := &WhatsNewResponse{
		Version:     release.Version,
		PublishedAt: release.PublishedAt.Format(time.RFC3339),
		Title:       release.Title,
		Content:     h.processContent(ctx, release.Content),
	}

	// Generate presigned URL for hero image
	if release.ImageKey != "" && h.storageR2 != nil {
		url, err := h.storageR2.GetPresignedURL(ctx, release.ImageKey, time.Hour)
		if err == nil {
			response.ImageURL = url
		}
	}

	// Cache the response
	h.setCache(ctx, response)

	c.JSON(http.StatusOK, response)
}

// processContent replaces image markers with presigned URLs
func (h *WhatsNewHandler) processContent(ctx context.Context, content string) string {
	if h.storageR2 == nil {
		return content
	}

	// Replace <!-- image: KEY --> markers with presigned URLs
	imageRe := regexp.MustCompile(`<!--\s*image:\s*([^\s]+)\s*-->`)
	return imageRe.ReplaceAllStringFunc(content, func(match string) string {
		matches := imageRe.FindStringSubmatch(match)
		if len(matches) < 2 {
			return match
		}
		key := matches[1]
		url, err := h.storageR2.GetPresignedURL(ctx, key, time.Hour)
		if err != nil {
			return match
		}
		return "![image](" + url + ")"
	})
}

// getFromCache retrieves cached response from Redis
func (h *WhatsNewHandler) getFromCache(ctx context.Context) (*WhatsNewResponse, error) {
	if h.redisClient == nil {
		return nil, errors.New("no redis client")
	}

	data, err := h.redisClient.Get(ctx, whatsNewCacheKey)
	if err != nil {
		return nil, err
	}

	var response WhatsNewResponse
	if err := json.Unmarshal([]byte(data), &response); err != nil {
		return nil, err
	}

	return &response, nil
}

// setCache stores response in Redis
func (h *WhatsNewHandler) setCache(ctx context.Context, response *WhatsNewResponse) {
	if h.redisClient == nil {
		return
	}

	data, err := json.Marshal(response)
	if err != nil {
		return
	}

	_ = h.redisClient.Set(ctx, whatsNewCacheKey, string(data), h.cacheTTL)
}
