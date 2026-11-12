package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// nodes is the table of node sizes, ports and guard limits. The deploy scripts and the OpenTofu
// module read the same file, so a node is described once. A size's packet budget admits only as many
// classes as keep the node's own CPU under about 65% of what its vCPUs deliver at the worst steal
// seen (52% over 10 s): a 3-person, 2-camera class reserves 7170 packets/s and costs about 11% of
// one vCPU, so 22000 admits 3 classes on 1 vCPU and 36000 admits 5 on 2 (docs/sfu/capacity-calibration.md).
// Production closes admission to new Episodes at 40% steal; the other environments keep 25 so the
// guard stays easy to exercise there.
//
//go:embed node.json
var nodesJSON []byte

type nodeTable struct {
	Ports struct {
		Control int `json:"control"`
		Media   int `json:"media"`
	} `json:"ports"`
	DefaultSize string `json:"defaultSize"`
	Sizes       map[string]struct {
		PacketBudget int `json:"packetBudget"`
	} `json:"sizes"`
	StealPercent struct {
		Production int `json:"production"`
		Other      int `json:"other"`
	} `json:"stealPercent"`
}

var nodes = func() nodeTable {
	var table nodeTable
	if err := json.Unmarshal(nodesJSON, &table); err != nil {
		panic(fmt.Sprintf("node.json: %v", err))
	}
	return table
}()
