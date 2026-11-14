package mediaplane

import "testing"

func TestClientProviders(t *testing.T) {
	tests := []struct {
		name       string
		list       string
		chalk      bool
		cloudflare bool
	}{
		{name: "an SDK that declares nothing runs Cloudflare only", list: "", cloudflare: true},
		{name: "a declared Chalk SFU", list: "cloudflare_sfu, chalk_sfu", chalk: true, cloudflare: true},
		{name: "unknown names are ignored", list: "later_sfu,chalk_sfu", chalk: true, cloudflare: true},
		{name: "a near miss is not the Chalk SFU", list: "chalk_sfu_v2,CHALK_SFU", cloudflare: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clients := ParseClientProviders(test.list)
			if got := clients.Runs(ProviderChalkSFU); got != test.chalk {
				t.Fatalf("runs chalk_sfu = %v, want %v", got, test.chalk)
			}
			if got := clients.Runs(ProviderCloudflareSFU); got != test.cloudflare {
				t.Fatalf("runs cloudflare_sfu = %v, want %v", got, test.cloudflare)
			}
			if clients.Runs("later_sfu") {
				t.Fatal("an unknown provider runs")
			}
		})
	}
}
