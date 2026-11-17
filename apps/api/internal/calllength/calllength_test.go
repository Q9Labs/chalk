package calllength

import "testing"

func TestPoliciesStayInsideTheSpaceBounds(t *testing.T) {
	for name, policy := range map[string]Policy{"anonymous": Anonymous, "api": API} {
		if policy.DefaultSeconds < MinimumSeconds || policy.MaximumSeconds > MaximumSeconds {
			t.Errorf("%s policy %+v is outside %d..%d seconds", name, policy, MinimumSeconds, MaximumSeconds)
		}
		if policy.DefaultSeconds > policy.MaximumSeconds {
			t.Errorf("%s policy %+v starts longer than it can run", name, policy)
		}
		if policy.LingerSeconds < 0 || policy.LingerSeconds > MaximumSeconds {
			t.Errorf("%s policy %+v has linger outside 0..%d seconds", name, policy, MaximumSeconds)
		}
	}
}

func TestAnonymousCallsCannotBeExtended(t *testing.T) {
	if Anonymous.DefaultSeconds != Anonymous.MaximumSeconds {
		t.Fatalf("anonymous policy %+v leaves room to extend", Anonymous)
	}
	if got := Anonymous.MaximumLifetime().Hours(); got != 1 {
		t.Fatalf("anonymous lifetime = %v hours, want 1", got)
	}
}
