package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"net/http"
)

var (
	apiErrorTenantLiveEpisodeLimit = APIError{Status: http.StatusConflict, Code: tenantlimits.LiveEpisodeLimitCode, Message: "Tenant live Episode limit reached"}
	apiErrorTenantRecordingLimit   = APIError{Status: http.StatusConflict, Code: tenantlimits.RecordingLimitCode, Message: "Tenant recording limit reached"}
)
