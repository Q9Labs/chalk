package handlers

import (
	"net/http"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	infraops "github.com/Q9Labs/chalk/internal/infrastructure/ops"
	"github.com/gin-gonic/gin"
)

type OpsIngestHandler struct {
	service *infraops.Service
}

func NewOpsIngestHandler(service *infraops.Service) *OpsIngestHandler {
	return &OpsIngestHandler{service: service}
}

type monitorResultRequest struct {
	MonitorKey        string         `json:"monitor_key" binding:"required"`
	Status            string         `json:"status" binding:"required"`
	CheckedAt         string         `json:"checked_at"`
	RunID             string         `json:"run_id"`
	ResultKey         string         `json:"result_key"`
	HTTPStatus        *int32         `json:"http_status"`
	LatencyMs         *int32         `json:"latency_ms"`
	ErrorCode         string         `json:"error_code"`
	ErrorMessage      string         `json:"error_message"`
	Details           map[string]any `json:"details"`
	ReportedSource    string         `json:"reported_source"`
	ReportedEmitterID string         `json:"reported_emitter_id"`
}

type heartbeatEventRequest struct {
	HeartbeatKey      string         `json:"heartbeat_key" binding:"required"`
	Status            string         `json:"status" binding:"required"`
	EventAt           string         `json:"event_at"`
	EventKey          string         `json:"event_key"`
	ErrorMessage      string         `json:"error_message"`
	Details           map[string]any `json:"details"`
	ReportedSource    string         `json:"reported_source"`
	ReportedEmitterID string         `json:"reported_emitter_id"`
}

func (h *OpsIngestHandler) MonitorResult(c *gin.Context) {
	var req monitorResultRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	checkedAt, err := parseIngestTime(req.CheckedAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid checked_at"})
		return
	}
	result, incident, err := h.service.IngestMonitorResult(c.Request.Context(), infraops.MonitorIngestInput{
		MonitorKey:        req.MonitorKey,
		Status:            domainops.SignalStatus(req.Status),
		CheckedAt:         checkedAt,
		RunID:             req.RunID,
		ResultKey:         req.ResultKey,
		HTTPStatus:        req.HTTPStatus,
		LatencyMs:         req.LatencyMs,
		ErrorCode:         req.ErrorCode,
		ErrorMessage:      req.ErrorMessage,
		Details:           req.Details,
		ReportedSource:    req.ReportedSource,
		ReportedEmitterID: req.ReportedEmitterID,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"result": result, "incident": incident})
}

func (h *OpsIngestHandler) HeartbeatEvent(c *gin.Context) {
	var req heartbeatEventRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	eventAt, err := parseIngestTime(req.EventAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid event_at"})
		return
	}
	event, incident, err := h.service.IngestHeartbeatEvent(c.Request.Context(), infraops.HeartbeatIngestInput{
		HeartbeatKey:      req.HeartbeatKey,
		Status:            domainops.HeartbeatStatus(req.Status),
		EventAt:           eventAt,
		EventKey:          req.EventKey,
		ErrorMessage:      req.ErrorMessage,
		Details:           req.Details,
		ReportedSource:    req.ReportedSource,
		ReportedEmitterID: req.ReportedEmitterID,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"event": event, "incident": incident})
}

func parseIngestTime(raw string) (time.Time, error) {
	if raw == "" {
		return time.Now().UTC(), nil
	}
	return time.Parse(time.RFC3339, raw)
}
