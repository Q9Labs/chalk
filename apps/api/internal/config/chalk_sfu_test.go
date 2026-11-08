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

func TestChalkSFUNodeRolesAndStandbyBudget(t *testing.T) {
	setChalkSFUEnv(t, "sfu-a=https://a.chalk.test:8443,primary:sfu-b=https://b.chalk.test:8443,standby:sfu-c=https://c.chalk.test:8443")
	t.Setenv(ChalkSFUStandbyBudget, "")
	config, err := loadChalkSFUConfig()
	if err != nil {
		t.Fatal(err)
	}
	roles := []ChalkSFURole{ChalkSFURolePrimary, ChalkSFURolePrimary, ChalkSFURoleStandby}
	for index, node := range config.Nodes {
		if node.Role != roles[index] {
			t.Fatalf("node %q has role %q, want %q", node.ID, node.Role, roles[index])
		}
	}
	if config.StandbyPacketBudget != DefaultChalkSFUStandbyBudget {
		t.Fatalf("standby budget %d, want the default %d", config.StandbyPacketBudget, DefaultChalkSFUStandbyBudget)
	}

	t.Setenv(ChalkSFUStandbyBudget, "8000")
	if config, err = loadChalkSFUConfig(); err != nil || config.StandbyPacketBudget != 8000 {
		t.Fatalf("standby budget %d, err %v, want 8000", config.StandbyPacketBudget, err)
	}
	for _, bad := range []string{"0", "-1", "lots"} {
		t.Setenv(ChalkSFUStandbyBudget, bad)
		if _, err := loadChalkSFUConfig(); err == nil || !strings.Contains(err.Error(), ChalkSFUStandbyBudget) {
			t.Fatalf("%s=%q: error %v, want the budget named", ChalkSFUStandbyBudget, bad, err)
		}
	}
}

func TestChalkSFUNodesRejectAnUnknownRole(t *testing.T) {
	setChalkSFUEnv(t, "spare:sfu-a=https://a.chalk.test:8443")
	if _, err := loadChalkSFUConfig(); err == nil || !strings.Contains(err.Error(), "spare") {
		t.Fatalf("error %v, want the unknown role named", err)
	}
}
