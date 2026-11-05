package config

import (
	"strings"
	"testing"
	"time"
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

func TestChalkSFUStaysOffUntilEnabled(t *testing.T) {
	t.Setenv(ChalkSFUEnabled, "")
	t.Setenv(ChalkSFUNodes, "not a node list")
	config, err := loadChalkSFUConfig()
	if err != nil || config.Enabled {
		t.Fatalf("disabled config: %+v, %v", config, err)
	}
}

func TestChalkSFUNodesKeepTheirOrder(t *testing.T) {
	setChalkSFUEnv(t, "sfu-a=https://sfu-a.chalk.test:8443, sfu-b=https://sfu-b.chalk.test:8443")
	config, err := loadChalkSFUConfig()
	if err != nil {
		t.Fatal(err)
	}
	want := []ChalkSFUNode{{ID: "sfu-a", ControlURL: "https://sfu-a.chalk.test:8443"}, {ID: "sfu-b", ControlURL: "https://sfu-b.chalk.test:8443"}}
	if len(config.Nodes) != 2 || config.Nodes[0] != want[0] || config.Nodes[1] != want[1] {
		t.Fatalf("nodes %+v, want %+v", config.Nodes, want)
	}
	if config.RequestTimeout != time.Duration(DefaultChalkSFUTimeoutMS)*time.Millisecond {
		t.Fatalf("timeout %s", config.RequestTimeout)
	}
}

func TestChalkSFUConfigRejectsInvalidNodes(t *testing.T) {
	cases := map[string]struct{ nodes, wantError string }{
		"missing":         {"", ChalkSFUNodes + " must be set"},
		"no id":           {"https://sfu-a.chalk.test:8443", "must be id=https://host:port"},
		"uppercase id":    {"SFU-A=https://sfu-a.chalk.test:8443", "must be id=https://host:port"},
		"duplicate id":    {"sfu-a=https://one.chalk.test,sfu-a=https://two.chalk.test", "twice"},
		"plain http":      {"sfu-a=http://sfu-a.chalk.test:8443", "absolute https URL"},
		"query in url":    {"sfu-a=https://sfu-a.chalk.test:8443/?debug=1", "absolute https URL"},
		"host is missing": {"sfu-a=https://", "absolute https URL"},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			setChalkSFUEnv(t, test.nodes)
			if _, err := loadChalkSFUConfig(); err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error %v, want it to contain %q", err, test.wantError)
			}
		})
	}
}

func TestChalkSFUConfigNeedsItsCertificates(t *testing.T) {
	setChalkSFUEnv(t, "sfu-a=https://sfu-a.chalk.test:8443")
	t.Setenv(ChalkSFUClientKeyFile, "")
	if _, err := loadChalkSFUConfig(); err == nil || !strings.Contains(err.Error(), ChalkSFUClientKeyFile) {
		t.Fatalf("error %v, want the missing client key named", err)
	}
}
