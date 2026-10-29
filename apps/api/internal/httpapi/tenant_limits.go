package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/platform/httpcontract"
)

var (
	apiErrorTenantLiveEpisodeLimit = httpcontract.APIError{Status: http.StatusConflict, Code: tenantlimits.LiveEpisodeLimitCode, Message: "Tenant live Episode limit reached"}
	apiErrorTenantRecordingLimit   = httpcontract.APIError{Status: http.StatusConflict, Code: tenantlimits.RecordingLimitCode, Message: "Tenant recording limit reached"}
)
