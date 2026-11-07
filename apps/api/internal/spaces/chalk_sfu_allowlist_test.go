package spaces

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestChalkSFUAllowlistNamesSpacesOnly(t *testing.T) {
	listed, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	other, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}

	list, err := ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	if !list.Allows(listed) || list.Allows(other) || list.Size() != 1 {
		t.Fatalf("listed=%v other=%v size=%d", list.Allows(listed), list.Allows(other), list.Size())
	}
	if (ChalkSFUAllowlist{}).Allows(listed) {
		t.Fatal("the zero allowlist must allow no Space")
	}
	everyone, err := ParseChalkSFUAllowlist([]string{"*"})
	if err != nil || !everyone.Allows(other) || everyone.Size() != -1 {
		t.Fatalf("* allows every Space: %v, %d, %v", everyone.Allows(other), everyone.Size(), err)
	}
	if _, err := ParseChalkSFUAllowlist([]string{"not-a-space"}); err == nil {
		t.Fatal("a malformed entry must fail the parse, not silently shrink the list")
	}
}

func TestOnlyAllowlistedSpacesSelectTheOwnSFU(t *testing.T) {
	listed, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	other, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	list, err := ParseChalkSFUAllowlist([]string{listed.String()})
	if err != nil {
		t.Fatal(err)
	}
	service := Service{}.WithChalkSFUAllowlist(list)
	chalk := string(MediaPlaneProviderChalkSFU)
	cloudflare := string(MediaPlaneProviderCloudflareSFU)
	if !service.selectable(chalk, listed) || service.selectable(chalk, other) {
		t.Fatal("only the listed Space may select chalk_sfu")
	}
	if !service.selectable(cloudflare, other) || !(Service{}).selectable(cloudflare, other) {
		t.Fatal("Cloudflare stays selectable for every Space")
	}
	if (Service{}).selectable(chalk, listed) {
		t.Fatal("a service with no allowlist refuses chalk_sfu")
	}
}

func TestNewSpacesGetTheNewSpacePlane(t *testing.T) {
	cases := []struct {
		name    string
		service Service
		want    MediaPlaneProvider
		wantErr error
	}{
		{"no default", Service{}, "", nil},
		{"deployment default", NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU), MediaPlaneProviderCloudflareSFU, nil},
		{"new Space plane replaces the default", NewServiceWithDefaultProvider(nil, MediaPlaneProviderCloudflareSFU).WithNewSpaceMediaPlane(MediaPlaneProviderChalkSFU), MediaPlaneProviderChalkSFU, nil},
		{"own SFU deployment default is refused", NewServiceWithDefaultProvider(nil, MediaPlaneProviderChalkSFU), "", ErrInvalidMediaPlane},
	}
	for _, c := range cases {
		got, err := c.service.planeForNewSpace()
		if got != c.want || err != c.wantErr {
			t.Errorf("%s: got %q, %v; want %q, %v", c.name, got, err, c.want, c.wantErr)
		}
	}
}
