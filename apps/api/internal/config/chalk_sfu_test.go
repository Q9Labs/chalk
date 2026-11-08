package config

import (
	"strings"
	"testing"
)

func setChalkSFUEnv(t *testing.T, nodes string) {
	t.Helper()
	t.Setenv(ChalkSFUEnabled, "true")
	t.Setenv(ChalkSFUApplicationID, "pool-a")
	t.Setenv(ChalkSFUNodes, nodes)
	t.Setenv(ChalkSFUServerName, "sfu.chalk.test")
	t.Setenv(ChalkSFUCAFile, "ca.pem")
	t.Setenv(ChalkSFUClientCertFile, "client.pem")
	t.Setenv(ChalkSFUClientKeyFile, "client.key")
	t.Setenv(ChalkSFUTimeoutMS, "")
	t.Setenv(ChalkSFUSTUNURLs, "")
}

func TestChalkSFUCloudflareOverflowDefaultsOnAndSwitchesOff(t *testing.T) {
	setChalkSFUEnv(t, "sfu-a=https://sfu-a.chalk.test:8443")
	for value, want := range map[string]bool{"": true, "true": true, "false": false} {
		t.Setenv(ChalkSFUCloudflareOverflow, value)
		config, err := loadChalkSFUConfig()
		if err != nil || config.CloudflareOverflow != want {
			t.Fatalf("%s=%q: overflow %t, err %v, want %t", ChalkSFUCloudflareOverflow, value, config.CloudflareOverflow, err, want)
		}
	}
	t.Setenv(ChalkSFUCloudflareOverflow, "sometimes")
	if _, err := loadChalkSFUConfig(); err == nil || !strings.Contains(err.Error(), ChalkSFUCloudflareOverflow) {
		t.Fatalf("error %v, want the invalid switch named", err)
	}
}
