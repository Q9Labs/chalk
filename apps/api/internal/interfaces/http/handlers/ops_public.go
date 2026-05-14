package handlers

import (
	"net/http"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	infraops "github.com/Q9Labs/chalk/internal/infrastructure/ops"
	"github.com/gin-gonic/gin"
)

type OpsPublicHandler struct {
	service *infraops.Service
}

func NewOpsPublicHandler(service *infraops.Service) *OpsPublicHandler {
	return &OpsPublicHandler{service: service}
}

func (h *OpsPublicHandler) StatusSummary(c *gin.Context) {
	summary, err := h.service.PublicStatus(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, summary)
}

func (h *OpsPublicHandler) Incident(c *gin.Context) {
	details, err := h.service.PublicIncident(c.Request.Context(), c.Param("incidentCode"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "incident not found"})
		return
	}
	c.JSON(http.StatusOK, details)
}

func (h *OpsPublicHandler) StatusCard(c *gin.Context) {
	summary, err := h.service.PublicStatus(c.Request.Context())
	if err != nil {
		summary = infraops.PublicStatusSummary{
			GeneratedAt: time.Now().UTC(),
			Overall:     domainops.ComponentStateDegraded,
		}
	}

	card, renderErr := infraops.BuildPublicStatusCardPNG(summary)
	if renderErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to render status card"})
		return
	}

	c.Header("Cache-Control", "public, max-age=60, s-maxage=60")
	c.Header("X-Robots-Tag", "noindex, nofollow")
	c.Data(http.StatusOK, "image/png", card)
}
