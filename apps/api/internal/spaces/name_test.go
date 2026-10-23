package spaces

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSpaceNameBound(t *testing.T) {
	tenant, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	for _, char := range []string{"n", "🎥"} {
		for _, size := range []int{MaxNameCodePoints, MaxNameCodePoints + 1} {
			name := strings.Repeat(char, size)
			create := CreateSpaceInput{TenantID: tenant, Name: name, Slug: "fixture", MediaPlane: string(MediaPlaneProviderCloudflareSFU)}
			update := UpdateSpaceInput{Name: utilities.OptionalString{Set: true, Value: &name}}
			for _, result := range []error{prepareCreateSpaceInput(&create), prepareUpdateSpaceInput(&update)} {
				if size == MaxNameCodePoints && result != nil {
					t.Fatalf("accepted name rejected: %v", result)
				}
				if size > MaxNameCodePoints && !errors.Is(result, ErrInvalidSpaceName) {
					t.Fatalf("oversized name accepted: %v", result)
				}
			}
		}
	}
	// A value whose field is omitted does not request a rename.
	ignored := strings.Repeat("n", MaxNameCodePoints+1)
	update := UpdateSpaceInput{Name: utilities.OptionalString{Value: &ignored}}
	if err := prepareUpdateSpaceInput(&update); err != nil {
		t.Fatalf("omitted name rejected: %v", err)
	}
}
