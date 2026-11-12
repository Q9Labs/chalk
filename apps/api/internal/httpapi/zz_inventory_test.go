package httpapi

import (
	"fmt"
	"testing"
)

func TestZZInventory(t *testing.T) {
	for i, g := range v1RouteGroups(Options{}) {
		for _, e := range g.endpoints {
			c := e.RouteContract()
			perm := ""
			if c.Permission != nil {
				perm = string(c.Permission.Scope)
			}
			fmt.Printf("INV g%d %-6s %-70s auth=%-20s perm=%s rl=%s\n", i, c.Method, c.Path, c.Auth, perm, c.RateLimit.Name)
		}
	}
}
