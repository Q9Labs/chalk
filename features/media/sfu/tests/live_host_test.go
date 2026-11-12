package tests

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// hostSample is the generator host's own load, so a run can show the
// generator was not the bottleneck. It is empty where /proc is absent.
type hostSample struct {
	CPUPercent      float64 `json:"cpuPercent"`
	StealPercent    float64 `json:"stealPercent"`
	UDPRcvbufErrors uint64  `json:"udpRcvbufErrors"`
}

type hostCPU struct{ total, idle, steal uint64 }

func readHostCPU() hostCPU {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return hostCPU{}
	}
	defer file.Close()
	line, _ := bufio.NewReader(file).ReadString('\n')
	var cpu hostCPU
	for index, field := range strings.Fields(line)[1:] {
		var value uint64
		_, _ = fmt.Sscan(field, &value)
		cpu.total += value
		switch index {
		case 3, 4: // idle, iowait
			cpu.idle += value
		case 7:
			cpu.steal = value
		}
	}
	return cpu
}

func (c *hostCPU) sample() hostSample {
	next := readHostCPU()
	var sample hostSample
	if total := float64(next.total - c.total); total > 0 {
		sample.CPUPercent = 100 * (total - float64(next.idle-c.idle)) / total
		sample.StealPercent = 100 * float64(next.steal-c.steal) / total
	}
	*c = next
	if raw, err := os.ReadFile("/proc/net/snmp"); err == nil {
		var header []string
		for line := range strings.Lines(string(raw)) {
			fields := strings.Fields(line)
			if len(fields) == 0 || fields[0] != "Udp:" {
				continue
			}
			if header == nil {
				header = fields
				continue
			}
			for index, name := range header {
				if name == "RcvbufErrors" && index < len(fields) {
					_, _ = fmt.Sscan(fields[index], &sample.UDPRcvbufErrors)
				}
			}
		}
	}
	return sample
}

// post and get call the node without failing the test, so one slow sample
// does not end an hour-long run.
func post(svc *service, path string, body, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	response, err := svc.client.Post(svc.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("POST %s: %s", path, response.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func get(svc *service, path string, out any) error {
	response, err := svc.client.Get(svc.baseURL + path)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("GET %s: %s", path, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func liveClient(t *testing.T) *http.Client {
	t.Helper()
	pem, err := os.ReadFile(os.Getenv("SFU_LIVE_CA"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	pair, err := tls.LoadX509KeyPair(os.Getenv("SFU_LIVE_CERT"), os.Getenv("SFU_LIVE_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "chalk-sfu", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}
