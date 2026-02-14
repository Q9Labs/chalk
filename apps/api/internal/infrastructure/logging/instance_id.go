package logging

import (
	"os"
	"strconv"
	"sync"
)

var (
	instanceIDOnce sync.Once
	instanceID     string
)

// InstanceID identifies the running API process. Stable for the lifetime of the process.
// Override with CHALK_INSTANCE_ID if you want a human-readable value in logs.
func InstanceID() string {
	instanceIDOnce.Do(func() {
		if v := os.Getenv("CHALK_INSTANCE_ID"); v != "" {
			instanceID = v
			return
		}
		host, _ := os.Hostname()
		instanceID = host + ":" + strconv.Itoa(os.Getpid())
	})
	return instanceID
}

