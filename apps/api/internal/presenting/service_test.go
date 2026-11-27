package presenting

import (
	"context"
	"errors"
	"testing"
)

func TestClaimRenderDisabledByRuntimeAvailability(t *testing.T) {
	service := NewService(nil, nil, nil).WithAvailability(func(context.Context) bool { return false })
	_, _, err := service.ClaimRender(context.Background(), RenderCapability{})
	if !errors.Is(err, ErrRenderUnavailable) {
		t.Fatalf("disabled claim error = %v", err)
	}
}
