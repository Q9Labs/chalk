package publicinvites

import "encoding/base64"

func validateClientPayload(grant PublicAccessGrant) error {
	payload := grant.ClientPayload
	switch grant.Provider {
	case PublicProviderCloudflareSFU:
		if !validClientPayloadField(payload.ConnectionID) || !validClientPayloadField(payload.StunServer) || payload.ProviderSubject != "" || payload.Token != "" {
			return ErrInvalidArrival
		}
	case PublicProviderChalkSFU:
		if !validClientPayloadField(payload.ConnectionID) || !validClientPayloadField(payload.EpisodeRef) || payload.StunServer != "" || payload.ProviderSubject != "" || payload.Token != "" {
			return ErrInvalidArrival
		}

	default:
		return ErrInvalidArrival
	}
	return nil
}

func validClientPayloadField(value string) bool {
	return value != "" && len(value) <= MaxClientPayloadFieldBytes && isASCII(value)
}

func validErrorFamily(value string) bool {
	if len(value) == 0 || len(value) > MaxLifecycleErrorFamilySize || !isASCII(value) {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' && character != '.' {
			return false
		}
	}
	return true
}

func decodeGuestCredential(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil && len(decoded) >= 16 && len(decoded) <= 256 {
		return decoded, nil
	}
	return []byte(value), nil
}
