package webhook

import "encoding/json"

// ExtractWebhookSecret returns the post-meeting webhook secret from tenant config.
func ExtractWebhookSecret(tenantConfig []byte) (string, error) {
	if tenantConfig == nil {
		return "", nil
	}

	var config struct {
		PostMeetingWebhook *struct {
			Secret string `json:"secret"`
		} `json:"post_meeting_webhook"`
	}

	if err := json.Unmarshal(tenantConfig, &config); err != nil {
		return "", err
	}

	if config.PostMeetingWebhook == nil {
		return "", nil
	}

	return config.PostMeetingWebhook.Secret, nil
}
