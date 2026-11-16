package config

import "time"

const R2InternalEndpoint = "CHALK_R2_INTERNAL_ENDPOINT"

type R2Config struct {
	AccessKeyID      string
	AccountID        string
	Bucket           string
	Endpoint         string
	InternalEndpoint string
	SecretAccessKey  string
	RequestTimeout   time.Duration
}
