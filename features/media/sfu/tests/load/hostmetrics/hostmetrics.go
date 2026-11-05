// Package hostmetrics samples Linux host and process counters from /proc and
// turns two readings into per-second rates. The load generator and the
// instrumented SFU node share it, so both report CPU, steal and network the same way.
//
// On a system without /proc every reading is zero; the callers still run.
package hostmetrics

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	clockTicksPerSecond = 100 // USER_HZ on Linux
	pageSize            = 4096
)

// Sample holds the rates between two readings. CPU figures are percent of the
// whole host (all vCPUs), so 100 means every vCPU is busy.
type Sample struct {
	UnixMs      int64   `json:"unixMs"`
	IntervalSec float64 `json:"intervalSec"`
	NumCPU      int     `json:"numCpu"`

	HostBusyPct float64 `json:"hostBusyPct"` // user + nice + system + irq + softirq
	UserPct     float64 `json:"userPct"`
	SystemPct   float64 `json:"systemPct"`
	SoftIRQPct  float64 `json:"softIrqPct"`
	StealPct    float64 `json:"stealPct"`
	IdlePct     float64 `json:"idlePct"`
	ProcCPUPct  float64 `json:"procCpuPct"` // this process, user + system
	RSSBytes    uint64  `json:"rssBytes"`

	NetRxPPS  float64 `json:"netRxPps"`
	NetTxPPS  float64 `json:"netTxPps"`
	NetRxMbps float64 `json:"netRxMbps"`
	NetTxMbps float64 `json:"netTxMbps"`

	UDPInPPS          float64 `json:"udpInPps"`
	UDPOutPPS         float64 `json:"udpOutPps"`
	UDPInErrPPS       float64 `json:"udpInErrPps"`
	UDPRcvbufErrPPS   float64 `json:"udpRcvbufErrPps"`
	UDPSndbufErrPPS   float64 `json:"udpSndbufErrPps"`
	UDPInDatagrams    uint64  `json:"udpInDatagramsTotal"`
	UDPOutDatagrams   uint64  `json:"udpOutDatagramsTotal"`
	UDPRcvbufErrTotal uint64  `json:"udpRcvbufErrTotal"`
}

type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (c cpuTimes) total() uint64 {
	return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal
}

type udpCounters struct {
	in, inErrors, out, rcvbufErrors, sndbufErrors uint64
}

type reading struct {
	at        time.Time
	cpu       cpuTimes
	procTicks uint64
	rss       uint64
	rxPackets uint64
	rxBytes   uint64
	txPackets uint64
	txBytes   uint64
	udp       udpCounters
}

// Reader turns successive readings into Samples.
type Reader struct {
	iface string
	last  reading
}

// NewReader starts a reader. iface is the network interface to count ("eth0").
func NewReader(iface string) *Reader {
	return &Reader{iface: iface, last: read(iface)}
}

// Next returns the rates since the previous call.
func (r *Reader) Next() Sample {
	now := read(r.iface)
	previous := r.last
	r.last = now

	seconds := now.at.Sub(previous.at).Seconds()
	sample := Sample{
		UnixMs:          now.at.UnixMilli(),
		IntervalSec:     seconds,
		NumCPU:          runtime.NumCPU(),
		RSSBytes:        now.rss,
		UDPInDatagrams:  now.udp.in,
		UDPOutDatagrams: now.udp.out,

		UDPRcvbufErrTotal: now.udp.rcvbufErrors,
	}
	if seconds <= 0 {
		return sample
	}
	if total := float64(now.cpu.total() - previous.cpu.total()); total > 0 {
		pct := func(current, before uint64) float64 { return 100 * float64(current-before) / total }
		sample.UserPct = pct(now.cpu.user+now.cpu.nice, previous.cpu.user+previous.cpu.nice)
		sample.SystemPct = pct(now.cpu.system, previous.cpu.system)
		sample.SoftIRQPct = pct(now.cpu.softirq, previous.cpu.softirq)
		sample.StealPct = pct(now.cpu.steal, previous.cpu.steal)
		sample.IdlePct = pct(now.cpu.idle+now.cpu.iowait, previous.cpu.idle+previous.cpu.iowait)
		sample.HostBusyPct = sample.UserPct + sample.SystemPct + pct(now.cpu.irq, previous.cpu.irq) + sample.SoftIRQPct
	}
	capacitySeconds := seconds * float64(sample.NumCPU)
	sample.ProcCPUPct = 100 * float64(now.procTicks-previous.procTicks) / clockTicksPerSecond / capacitySeconds

	rate := func(current, before uint64) float64 { return float64(current-before) / seconds }
	sample.NetRxPPS = rate(now.rxPackets, previous.rxPackets)
	sample.NetTxPPS = rate(now.txPackets, previous.txPackets)
	sample.NetRxMbps = rate(now.rxBytes, previous.rxBytes) * 8 / 1e6
	sample.NetTxMbps = rate(now.txBytes, previous.txBytes) * 8 / 1e6
	sample.UDPInPPS = rate(now.udp.in, previous.udp.in)
	sample.UDPOutPPS = rate(now.udp.out, previous.udp.out)
	sample.UDPInErrPPS = rate(now.udp.inErrors, previous.udp.inErrors)
	sample.UDPRcvbufErrPPS = rate(now.udp.rcvbufErrors, previous.udp.rcvbufErrors)
	sample.UDPSndbufErrPPS = rate(now.udp.sndbufErrors, previous.udp.sndbufErrors)
	return sample
}

func read(iface string) reading {
	r := reading{at: time.Now()}
	r.cpu = readCPU()
	r.procTicks, r.rss = readProcess()
	r.rxBytes, r.rxPackets, r.txBytes, r.txPackets = readNet(iface)
	r.udp = readUDP()
	return r
}

func readCPU() cpuTimes {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return cpuTimes{}
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 9 || fields[0] != "cpu" {
		return cpuTimes{}
	}
	value := func(i int) uint64 { return parse(fields[i]) }
	return cpuTimes{user: value(1), nice: value(2), system: value(3), idle: value(4), iowait: value(5), irq: value(6), softirq: value(7), steal: value(8)}
}

// readProcess returns this process's user+system clock ticks and resident bytes.
func readProcess() (ticks, rss uint64) {
	if raw, err := os.ReadFile("/proc/self/stat"); err == nil {
		text := string(raw)
		// Field 2 (the command) may hold spaces; the rest starts after its closing parenthesis.
		if end := strings.LastIndexByte(text, ')'); end >= 0 {
			fields := strings.Fields(text[end+1:])
			if len(fields) > 12 {
				ticks = parse(fields[11]) + parse(fields[12]) // utime, stime
			}
		}
	}
	if raw, err := os.ReadFile("/proc/self/statm"); err == nil {
		if fields := strings.Fields(string(raw)); len(fields) > 1 {
			rss = parse(fields[1]) * pageSize
		}
	}
	return ticks, rss
}

func readNet(iface string) (rxBytes, rxPackets, txBytes, txPackets uint64) {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, 0, 0
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		name, counters, found := strings.Cut(scanner.Text(), ":")
		if !found || strings.TrimSpace(name) != iface {
			continue
		}
		fields := strings.Fields(counters)
		if len(fields) < 10 {
			return 0, 0, 0, 0
		}
		return parse(fields[0]), parse(fields[1]), parse(fields[8]), parse(fields[9])
	}
	return 0, 0, 0, 0
}

func readUDP() udpCounters {
	file, err := os.Open("/proc/net/snmp")
	if err != nil {
		return udpCounters{}
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	var header []string
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || fields[0] != "Udp:" {
			continue
		}
		if header == nil {
			header = fields
			continue
		}
		values := map[string]uint64{}
		for i := 1; i < len(fields) && i < len(header); i++ {
			values[header[i]] = parse(fields[i])
		}
		return udpCounters{in: values["InDatagrams"], inErrors: values["InErrors"], out: values["OutDatagrams"], rcvbufErrors: values["RcvbufErrors"], sndbufErrors: values["SndbufErrors"]}
	}
	return udpCounters{}
}

func parse(text string) uint64 {
	value, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return 0
	}
	return value
}
