package ops

import (
	"fmt"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
)

type StaticCatalog struct {
	components      []domainops.ComponentDefinition
	componentsByKey map[domainops.ComponentKey]domainops.ComponentDefinition

	monitors      []domainops.MonitorDefinition
	monitorsByKey map[domainops.MonitorKey]domainops.MonitorDefinition

	heartbeats      []domainops.HeartbeatDefinition
	heartbeatsByKey map[domainops.HeartbeatKey]domainops.HeartbeatDefinition
}

func NewStaticCatalog() (*StaticCatalog, error) {
	componentDefs := []domainops.ComponentDefinition{
		{
			Key:           domainops.ComponentKeyAPI,
			DisplayName:   "API",
			Description:   "Chalk API availability and request health",
			PublicVisible: true,
		},
		{
			Key:           domainops.ComponentKeyWebApp,
			DisplayName:   "Web App",
			Description:   "Website and application shell availability",
			PublicVisible: true,
		},
		{
			Key:           domainops.ComponentKeyRealtime,
			DisplayName:   "Realtime",
			Description:   "Room join/connect experience",
			PublicVisible: true,
		},
		{
			Key:           domainops.ComponentKeyPostMeeting,
			DisplayName:   "Post Meeting",
			Description:   "Recordings, transcripts, and post-meeting processing",
			PublicVisible: true,
		},
	}

	monitorDefs := []domainops.MonitorDefinition{
		{
			Key:                         domainops.MonitorKeyAPIHealth,
			Kind:                        domainops.MonitorKindExternalHTTP,
			DisplayName:                 "API Health",
			Description:                 "GET /health external availability probe",
			ComponentKey:                domainops.ComponentKeyAPI,
			Severity:                    domainops.IncidentSeverityCritical,
			ExpectedInterval:            time.Minute,
			AutoOpenConsecutiveFailures: 3,
			HTTPMethod:                  "GET",
			HTTPPath:                    "/health",
		},
		{
			Key:                         domainops.MonitorKeyAPIDebugPing,
			Kind:                        domainops.MonitorKindExternalHTTP,
			DisplayName:                 "API Debug Ping",
			Description:                 "HEAD /api/v1/debug/ping external reachability probe",
			ComponentKey:                domainops.ComponentKeyAPI,
			Severity:                    domainops.IncidentSeverityMajor,
			ExpectedInterval:            time.Minute,
			AutoOpenConsecutiveFailures: 0,
			HTTPMethod:                  "HEAD",
			HTTPPath:                    "/api/v1/debug/ping",
		},
		{
			Key:                         domainops.MonitorKeyWebHome,
			Kind:                        domainops.MonitorKindExternalHTTP,
			DisplayName:                 "Web Home",
			Description:                 "GET / home page external availability probe",
			ComponentKey:                domainops.ComponentKeyWebApp,
			Severity:                    domainops.IncidentSeverityCritical,
			ExpectedInterval:            time.Minute,
			AutoOpenConsecutiveFailures: 3,
			HTTPMethod:                  "GET",
			HTTPPath:                    "/",
		},
		{
			Key:                         domainops.MonitorKeyWebStatus,
			Kind:                        domainops.MonitorKindExternalHTTP,
			DisplayName:                 "Web Status",
			Description:                 "GET /status public status route probe",
			ComponentKey:                domainops.ComponentKeyWebApp,
			Severity:                    domainops.IncidentSeverityMajor,
			ExpectedInterval:            time.Minute,
			AutoOpenConsecutiveFailures: 0,
			HTTPMethod:                  "GET",
			HTTPPath:                    "/status",
		},
		{
			Key:                         domainops.MonitorKeyOpsMonitorPipeline,
			Kind:                        domainops.MonitorKindSynthetic,
			DisplayName:                 "Ops Monitor Pipeline",
			Description:                 "Synthetic signal for monitor ingest pipeline liveness",
			ComponentKey:                domainops.ComponentKeyAPI,
			Severity:                    domainops.IncidentSeverityCritical,
			ExpectedInterval:            time.Minute,
			AutoOpenConsecutiveFailures: 1,
		},
	}

	heartbeatDefs := []domainops.HeartbeatDefinition{
		{
			Key:              domainops.HeartbeatKeyInternalRetentionJob,
			DisplayName:      "Internal Retention Job",
			Description:      "API-owned retention cleanup background job",
			ComponentKey:     domainops.ComponentKeyPostMeeting,
			Severity:         domainops.IncidentSeverityMajor,
			ExpectedInterval: 6 * time.Hour,
			GraceWindow:      DefaultHeartbeatGraceWindow(6 * time.Hour),
			AutoOpenOnMiss:   false,
		},
		{
			Key:              domainops.HeartbeatKeyWebhookDeliveryWorker,
			DisplayName:      "Webhook Delivery Worker",
			Description:      "Post-meeting webhook delivery processing worker",
			ComponentKey:     domainops.ComponentKeyPostMeeting,
			Severity:         domainops.IncidentSeverityCritical,
			ExpectedInterval: time.Minute,
			GraceWindow:      DefaultHeartbeatGraceWindow(time.Minute),
			AutoOpenOnMiss:   true,
		},
		{
			Key:              domainops.HeartbeatKeyPostMeetingProcessor,
			DisplayName:      "Post Meeting Processor",
			Description:      "Post-meeting processing loop liveness signal",
			ComponentKey:     domainops.ComponentKeyPostMeeting,
			Severity:         domainops.IncidentSeverityCritical,
			ExpectedInterval: time.Minute,
			GraceWindow:      DefaultHeartbeatGraceWindow(time.Minute),
			AutoOpenOnMiss:   true,
		},
		{
			Key:              domainops.HeartbeatKeyTranscriptionCallbackConsumer,
			DisplayName:      "Transcription Callback Consumer",
			Description:      "Cloudflare transcription callback consumer liveness signal",
			ComponentKey:     domainops.ComponentKeyPostMeeting,
			Severity:         domainops.IncidentSeverityMajor,
			ExpectedInterval: 5 * time.Minute,
			GraceWindow:      DefaultHeartbeatGraceWindow(5 * time.Minute),
			AutoOpenOnMiss:   false,
		},
	}

	catalog := &StaticCatalog{
		components:      cloneComponents(componentDefs),
		componentsByKey: make(map[domainops.ComponentKey]domainops.ComponentDefinition, len(componentDefs)),
		monitors:        cloneMonitors(monitorDefs),
		monitorsByKey:   make(map[domainops.MonitorKey]domainops.MonitorDefinition, len(monitorDefs)),
		heartbeats:      cloneHeartbeats(heartbeatDefs),
		heartbeatsByKey: make(map[domainops.HeartbeatKey]domainops.HeartbeatDefinition, len(heartbeatDefs)),
	}
	if err := catalog.indexAndValidate(); err != nil {
		return nil, err
	}
	return catalog, nil
}

func (c *StaticCatalog) Components() []domainops.ComponentDefinition {
	return cloneComponents(c.components)
}

func (c *StaticCatalog) Component(key domainops.ComponentKey) (domainops.ComponentDefinition, bool) {
	def, ok := c.componentsByKey[key]
	return def, ok
}

func (c *StaticCatalog) Monitors() []domainops.MonitorDefinition {
	return cloneMonitors(c.monitors)
}

func (c *StaticCatalog) Monitor(key domainops.MonitorKey) (domainops.MonitorDefinition, bool) {
	def, ok := c.monitorsByKey[key]
	return def, ok
}

func (c *StaticCatalog) Heartbeats() []domainops.HeartbeatDefinition {
	return cloneHeartbeats(c.heartbeats)
}

func (c *StaticCatalog) Heartbeat(key domainops.HeartbeatKey) (domainops.HeartbeatDefinition, bool) {
	def, ok := c.heartbeatsByKey[key]
	return def, ok
}

func (c *StaticCatalog) indexAndValidate() error {
	for _, component := range c.components {
		if err := component.Validate(); err != nil {
			return err
		}
		if _, exists := c.componentsByKey[component.Key]; exists {
			return fmt.Errorf("%w: duplicate component key %q", domainops.ErrInvalidCatalogDefinition, component.Key)
		}
		c.componentsByKey[component.Key] = component
	}

	for _, monitor := range c.monitors {
		if err := monitor.Validate(); err != nil {
			return err
		}
		if _, exists := c.componentsByKey[monitor.ComponentKey]; !exists {
			return fmt.Errorf("%w: monitor %q references unknown component %q", domainops.ErrInvalidCatalogDefinition, monitor.Key, monitor.ComponentKey)
		}
		if _, exists := c.monitorsByKey[monitor.Key]; exists {
			return fmt.Errorf("%w: duplicate monitor key %q", domainops.ErrInvalidCatalogDefinition, monitor.Key)
		}
		c.monitorsByKey[monitor.Key] = monitor
	}

	for _, heartbeat := range c.heartbeats {
		if err := heartbeat.Validate(); err != nil {
			return err
		}
		if _, exists := c.componentsByKey[heartbeat.ComponentKey]; !exists {
			return fmt.Errorf("%w: heartbeat %q references unknown component %q", domainops.ErrInvalidCatalogDefinition, heartbeat.Key, heartbeat.ComponentKey)
		}
		if _, exists := c.heartbeatsByKey[heartbeat.Key]; exists {
			return fmt.Errorf("%w: duplicate heartbeat key %q", domainops.ErrInvalidCatalogDefinition, heartbeat.Key)
		}
		c.heartbeatsByKey[heartbeat.Key] = heartbeat
	}

	return nil
}

func cloneComponents(input []domainops.ComponentDefinition) []domainops.ComponentDefinition {
	out := make([]domainops.ComponentDefinition, len(input))
	copy(out, input)
	return out
}

func cloneMonitors(input []domainops.MonitorDefinition) []domainops.MonitorDefinition {
	out := make([]domainops.MonitorDefinition, len(input))
	copy(out, input)
	return out
}

func cloneHeartbeats(input []domainops.HeartbeatDefinition) []domainops.HeartbeatDefinition {
	out := make([]domainops.HeartbeatDefinition, len(input))
	copy(out, input)
	return out
}
