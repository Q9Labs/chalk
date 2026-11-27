package config

import (
	"reflect"
	"testing"
)

func tcpLookup(values map[string]string) Lookup {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestTCPAddrsReadsThePluralSetting(t *testing.T) {
	r := reader{lookup: tcpLookup(map[string]string{"SFU_TCP_ADDR": ":50000", "SFU_TCP_ADDRS": ":50000,:443"})}
	if got := tcpAddrs(r); !reflect.DeepEqual(got, []string{":50000", ":443"}) {
		t.Fatalf("TCP listeners %v", got)
	}
}

func TestTCPAddrsKeepsTheLegacySingleListenerSetting(t *testing.T) {
	r := reader{lookup: tcpLookup(map[string]string{"SFU_TCP_ADDR": ":50000"})}
	if got := tcpAddrs(r); !reflect.DeepEqual(got, []string{":50000"}) {
		t.Fatalf("TCP listeners %v", got)
	}
}
