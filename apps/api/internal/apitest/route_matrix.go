// Package apitest holds the reviewed route cases shared by the router inventory
// and PostgreSQL-backed authorization tests. Production composition does not use it.
package apitest

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed route_access_matrix.json
var routeMatrixJSON []byte

type CredentialCase struct {
	Class   string `json:"class"`
	Wrong   int    `json:"wrong"`
	Foreign int    `json:"foreign"`
}

type RouteCase struct {
	Route           string           `json:"route"`
	Operation       string           `json:"operation"`
	Credentials     []CredentialCase `json:"credentials"`
	Body            string           `json:"body"`
	Query           string           `json:"query"`
	PublicReason    string           `json:"publicReason"`
	ProtocolReason  string           `json:"protocolReason"`
	IsolationReason string           `json:"isolationReason"`
}

func RouteMatrix() (map[string]RouteCase, error) {
	var cases []RouteCase
	if err := json.Unmarshal(routeMatrixJSON, &cases); err != nil {
		return nil, fmt.Errorf("read route access matrix: %w", err)
	}
	matrix := make(map[string]RouteCase, len(cases))
	for _, row := range cases {
		if _, exists := matrix[row.Route]; exists {
			return nil, fmt.Errorf("duplicate route access matrix row: %s", row.Route)
		}
		if row.Route == "" || (len(row.Credentials) == 0) != (row.PublicReason != "") {
			return nil, fmt.Errorf("route must name credential classes or a public reason: %s", row.Route)
		}
		matrix[row.Route] = row
	}
	return matrix, nil
}
