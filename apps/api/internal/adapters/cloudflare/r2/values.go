package r2

import (
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}

	return aws.String(value)
}

func positiveInt64(value int64) *int64 {
	if value <= 0 {
		return nil
	}

	return aws.Int64(value)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}

	return *value
}

func int64Value(value *int64) int64 {
	if value == nil {
		return 0
	}

	return *value
}

func timeValue(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}

	return *value
}
