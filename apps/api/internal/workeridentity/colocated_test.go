package workeridentity

import "testing"

func TestColocatedWorkerIDIsStablePerEnvironmentAndNode(t *testing.T) {
	got := ColocatedWorkerID("nightly", "sfu-1").String()
	// features/media/sfu/deploy/test_deploy.py pins the same value for the certs script.
	if want := "295f92b1-e2a9-8780-ab50-dbbb6c628d79"; got != want {
		t.Fatalf("ColocatedWorkerID(nightly, sfu-1) = %s, want %s", got, want)
	}
	if ColocatedWorkerID("nightly", "sfu-2") == ColocatedWorkerID("nightly", "sfu-1") || ColocatedWorkerID("production", "sfu-1") == ColocatedWorkerID("nightly", "sfu-1") {
		t.Fatal("a different node or environment must give a different worker ID")
	}
}
