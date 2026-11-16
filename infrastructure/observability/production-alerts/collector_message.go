package main

import (
	"time"
)

func message(rule string) (headline, impact, next string) {
	switch rule {
	case ruleRecording:
		return "A class was not recorded", "The Recording stopped before it finished, so there is no complete video for this class.", "An engineer must check immediately whether any retained source can be recovered; a complete video cannot be promised."
	case ruleRecordingStop:
		return "A Recording has not finished stopping", "Capture finished more than two minutes ago, but Sync still reports stopping. This can block Episode end and another Episode in the same Space.", "An engineer must check capture-stopped callback delivery and pipeline maintenance now."
	case ruleSyncReadiness:
		return "Sync has stayed unready", "Sync was unready in at least three of the last four minutes and the latest sample is still unready. Joining or reconnecting may fail; existing sockets may still work.", "An engineer must check Sync readiness and its dependency diagnostics now."
	case ruleSFUReadiness:
		return "A Chalk SFU node is refusing new calls or unreachable", "At least one Chalk SFU node was unhealthy in at least four minute samples in five minutes and the latest sample is still unhealthy. New calls may fail to start on it, and live calls may drop if the node is unreachable.", "An engineer must check the SFU nodes' readiness, load and network now."
	case ruleCertificateExpiry:
		return "A Chalk certificate is close to expiring", "A certificate that the Chalk SFU or the direct door needs will expire soon, is not trusted by the collector, or the direct door cannot be verified over TLS. Once it expires, calls on that path fail or fall back to the slower Tunnel.", "An engineer must renew it now: the SFU server certificate with certs <env> server then deploy, the API client certificate with certs <env> api, a CA that ends first by rotating the service CA (see the README), the direct door by checking that its proxy can renew over port 443."
	case ruleSFURetirementDebt:
		return "A Chalk SFU node is not answering retire requests", "The oldest unpaid retirement debt has stayed above its age limit. A node that never acknowledges a retire keeps the stale sessions of moved or ended Episodes until it restarts.", "An engineer must find the silent node and restart it if it is up but not answering control calls."
	case ruleExport:
		return "A class video could not be produced", "The class was recorded, but turning it into a video file failed or is taking longer than 14 hours.", "An engineer needs to fix the cause and retry the Export before the retained Recording expires; check its source cleanup deadline now."
	case ruleTranscript:
		return "A class transcript failed or is taking longer than 30 minutes", "The video is not affected.", "An engineer needs to check the source expiry and retry before it expires; a transcript cannot be promised."
	case ruleWebhook:
		return "A customer's system was not told about a class event", "Chalk tried several times to reach the customer's server and gave up, so their attendance or Recording records may be out of date.", "An engineer must check the customer's server now, then redeliver the event; automatic retries have ended."
	default:
		return healthMessage(rule)
	}
}

func formatMessage(item *snapshot) {
	item.Headline, item.Summary, item.Next = message(item.Rule)
	if item.Rule == ruleSyncReadiness || item.Rule == ruleSFUReadiness || item.Rule == ruleRuntimeHealth || (item.Rule == ruleCertificateExpiry && item.Value > 0) {
		item.Summary += " Latest readiness reason: " + item.Reason + "."
	}
	if item.Tenant != "" {
		item.TenantName = safeTenantName(item.TenantName)
		item.Summary = "Tenant: " + item.TenantName + ". " + item.Summary
	}
	if item.ExpiresAt != nil {
		if item.ExpiresAt.Before(time.Now()) {
			item.Next = "The earliest affected source expired at " + item.ExpiresAt.UTC().Format(time.RFC3339) + "; recovery is not promised. An engineer must check what remains now."
		} else {
			item.Next += " Earliest affected source expires at " + item.ExpiresAt.UTC().Format(time.RFC3339) + "."
		}
	}
	if (item.Rule == ruleExport || item.Rule == ruleTranscript) && item.Value > 0 && item.UnknownExpiry > 0 {
		item.Next += " Some source expiry times are unknown; an engineer must check them now."
	}
}
