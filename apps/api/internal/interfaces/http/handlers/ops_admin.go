package handlers

import (
	"net/http"
	"strconv"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	infraops "github.com/Q9Labs/chalk/internal/infrastructure/ops"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type OpsAdminHandler struct {
	service *infraops.Service
}

func NewOpsAdminHandler(service *infraops.Service) *OpsAdminHandler {
	return &OpsAdminHandler{service: service}
}

type opsActorRequest struct {
	ActorID   string `json:"actor_id"`
	ActorKind string `json:"actor_kind"`
}

type declareIncidentRequest struct {
	IncidentCode   string         `json:"incident_code"`
	Title          string         `json:"title" binding:"required"`
	Summary        string         `json:"summary"`
	Severity       string         `json:"severity" binding:"required"`
	Status         string         `json:"status"`
	Visibility     string         `json:"visibility"`
	SourceKind     string         `json:"source_kind"`
	SourceKey      string         `json:"source_key"`
	ComponentIDs   []string       `json:"component_ids"`
	DedupeKey      string         `json:"dedupe_key"`
	IdempotencyKey string         `json:"idempotency_key"`
	PublicMessage  string         `json:"public_message"`
	PublicTitle    string         `json:"public_title"`
	Metadata       map[string]any `json:"metadata"`
	EventMessage   string         `json:"event_message"`
	OccurredAt     string         `json:"occurred_at"`
	opsActorRequest
}

type addIncidentEventRequest struct {
	EventType      string         `json:"event_type" binding:"required"`
	Visibility     string         `json:"visibility"`
	Message        string         `json:"message" binding:"required"`
	Metadata       map[string]any `json:"metadata"`
	IdempotencyKey string         `json:"idempotency_key"`
	EventAt        string         `json:"event_at"`
	TransitionTo   string         `json:"transition_to"`
	PublicMessage  string         `json:"public_message"`
	PublicTitle    string         `json:"public_title"`
	UpdatedSummary string         `json:"updated_summary"`
	opsActorRequest
}

type publishIncidentRequest struct {
	Message       string `json:"message"`
	PublicMessage string `json:"public_message"`
	PublicTitle   string `json:"public_title"`
	EventAt       string `json:"event_at"`
	opsActorRequest
}

type resolveIncidentRequest struct {
	Message string `json:"message"`
	Summary string `json:"summary"`
	EventAt string `json:"event_at"`
	opsActorRequest
}

type maintenanceRequest struct {
	Title         string   `json:"title" binding:"required"`
	Summary       string   `json:"summary"`
	ComponentIDs  []string `json:"component_ids" binding:"required"`
	StartsAt      string   `json:"starts_at" binding:"required"`
	EndsAt        string   `json:"ends_at" binding:"required"`
	PublicMessage string   `json:"public_message"`
	opsActorRequest
}

func (h *OpsAdminHandler) DeclareIncident(c *gin.Context) {
	var req declareIncidentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	occurredAt, err := parseTimeOrNow(req.OccurredAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid occurred_at"})
		return
	}
	incident, err := h.service.DeclareIncident(c.Request.Context(), infraops.DeclareIncidentInput{
		IncidentCode:   req.IncidentCode,
		Title:          req.Title,
		Summary:        req.Summary,
		Severity:       domainops.Severity(req.Severity),
		Status:         domainops.IncidentStatus(req.Status),
		Visibility:     domainops.Visibility(req.Visibility),
		SourceKind:     domainops.SourceKind(req.SourceKind),
		SourceKey:      req.SourceKey,
		ComponentIDs:   req.ComponentIDs,
		DedupeKey:      req.DedupeKey,
		IdempotencyKey: req.IdempotencyKey,
		PublicMessage:  req.PublicMessage,
		PublicTitle:    req.PublicTitle,
		Metadata:       req.Metadata,
		OccurredAt:     occurredAt,
		Actor:          requestActor(req.opsActorRequest),
		EventMessage:   req.EventMessage,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, incident)
}

func (h *OpsAdminHandler) AddEvent(c *gin.Context) {
	var req addIncidentEventRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	eventAt, err := parseTimeOrNow(req.EventAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid event_at"})
		return
	}
	details, err := h.service.AddEvent(c.Request.Context(), infraops.AddEventInput{
		IncidentCode:   c.Param("incidentCode"),
		EventType:      req.EventType,
		Visibility:     domainops.Visibility(defaultIfEmpty(req.Visibility, string(domainops.VisibilityInternal))),
		Message:        req.Message,
		Metadata:       req.Metadata,
		IdempotencyKey: req.IdempotencyKey,
		EventAt:        eventAt,
		Actor:          requestActor(req.opsActorRequest),
		TransitionTo:   domainops.IncidentStatus(req.TransitionTo),
		PublicMessage:  req.PublicMessage,
		PublicTitle:    req.PublicTitle,
		UpdatedSummary: req.UpdatedSummary,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, details)
}

func (h *OpsAdminHandler) PublishIncident(c *gin.Context) {
	var req publishIncidentRequest
	if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	eventAt, err := parseTimeOrNow(req.EventAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid event_at"})
		return
	}
	details, err := h.service.PublishIncident(c.Request.Context(), infraops.PublishIncidentInput{
		IncidentCode:  c.Param("incidentCode"),
		Message:       req.Message,
		PublicMessage: req.PublicMessage,
		PublicTitle:   req.PublicTitle,
		Actor:         requestActor(req.opsActorRequest),
		EventAt:       eventAt,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, details)
}

func (h *OpsAdminHandler) ResolveIncident(c *gin.Context) {
	var req resolveIncidentRequest
	if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	eventAt, err := parseTimeOrNow(req.EventAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid event_at"})
		return
	}
	details, err := h.service.ResolveIncident(c.Request.Context(), infraops.ResolveIncidentInput{
		IncidentCode: c.Param("incidentCode"),
		Message:      req.Message,
		Summary:      req.Summary,
		Actor:        requestActor(req.opsActorRequest),
		EventAt:      eventAt,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, details)
}

func (h *OpsAdminHandler) GetIncident(c *gin.Context) {
	details, err := h.service.GetIncident(c.Request.Context(), c.Param("incidentCode"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "incident not found"})
		return
	}
	c.JSON(http.StatusOK, details)
}

func (h *OpsAdminHandler) ListIncidents(c *gin.Context) {
	limit, offset := int32(50), int32(0)
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			limit = int32(parsed)
		}
	}
	if raw := c.Query("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = int32(parsed)
		}
	}
	items, err := h.service.ListIncidents(c.Request.Context(), limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, items)
}

func (h *OpsAdminHandler) Overview(c *gin.Context) {
	overview, err := h.service.Overview(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, overview)
}

func (h *OpsAdminHandler) CreateMaintenance(c *gin.Context) {
	var req maintenanceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	startsAt, err := time.Parse(time.RFC3339, req.StartsAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid starts_at"})
		return
	}
	endsAt, err := time.Parse(time.RFC3339, req.EndsAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid ends_at"})
		return
	}
	window, err := h.service.ScheduleMaintenance(c.Request.Context(), req.Title, req.Summary, req.ComponentIDs, startsAt, endsAt, requestActor(req.opsActorRequest), req.PublicMessage)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, window)
}

func (h *OpsAdminHandler) CancelMaintenance(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid maintenance id"})
		return
	}
	window, err := h.service.CancelMaintenance(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "maintenance window not found"})
		return
	}
	c.JSON(http.StatusOK, window)
}

func (h *OpsAdminHandler) AIDrafts(c *gin.Context) {
	drafts, err := h.service.GenerateIncidentDrafts(c.Request.Context(), c.Param("incidentCode"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, drafts)
}

func requestActor(req opsActorRequest) infraops.Actor {
	kind := domainops.ActorKind(defaultIfEmpty(req.ActorKind, string(domainops.ActorKindAgent)))
	return infraops.Actor{Kind: kind, ID: defaultIfEmpty(req.ActorID, "agent")}
}

func parseTimeOrNow(raw string) (time.Time, error) {
	if raw == "" {
		return time.Now().UTC(), nil
	}
	return time.Parse(time.RFC3339, raw)
}

func defaultIfEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
