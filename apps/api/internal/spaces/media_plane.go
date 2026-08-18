package spaces

import (
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidMediaPlaneProvider = errors.New("invalid media plane provider")

type MediaPlaneProvider string

const (
	MediaPlaneProviderCloudflareSFU MediaPlaneProvider = "cf_sfu"
	MediaPlaneProviderCloudflareRTK MediaPlaneProvider = "cf_rtk"
)

func ParseMediaPlaneProvider(value string) (MediaPlaneProvider, error) {
	provider := MediaPlaneProvider(strings.TrimSpace(value))
	switch provider {
	case MediaPlaneProviderCloudflareSFU, MediaPlaneProviderCloudflareRTK:
		return provider, nil
	default:
		return "", fmt.Errorf("%w: %s", ErrInvalidMediaPlaneProvider, value)
	}
}
