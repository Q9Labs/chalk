package recorderworker

import "testing"

func TestMemoryInfoBytesReadsAvailableMemory(t *testing.T) {
	data := []byte("MemTotal:       524288 kB\nMemFree:  1200 kB\nMemAvailable:  245760 kB\n")
	if got, err := memoryInfoBytes(data, "MemAvailable:"); err != nil || got != 245760*1024 {
		t.Fatalf("available memory/error = %d/%v", got, err)
	}
	if _, err := memoryInfoBytes(data, "Missing:"); err == nil {
		t.Fatal("missing memory field accepted")
	}
}
