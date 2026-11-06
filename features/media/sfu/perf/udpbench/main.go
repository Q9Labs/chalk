// Command udpbench measures the CPU one process spends sending or receiving UDP
// media-sized packets at a fixed rate, one syscall per packet versus batched
// (sendmmsg/recvmmsg) and segmented (UDP_SEGMENT, GSO). Profiling scratch only.
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

var (
	mode    = flag.String("mode", "sendto", "sendto | mmsg | gso | mmsg-gso | recvfrom | recvmmsg")
	dst     = flag.String("dst", "", "destination IP")
	port    = flag.Int("port", 41000, "first destination port")
	dests   = flag.Int("dests", 6, "destinations (ports port..port+dests-1)")
	rate    = flag.Int("pps", 20000, "packets per second")
	size    = flag.Int("size", 1100, "payload bytes")
	frame   = flag.Int("frame", 8, "packets per burst to one destination")
	seconds = flag.Int("secs", 10, "duration")
	batch   = flag.Int("batch", 32, "recvmmsg batch / frames per sendmmsg")
)

func cpuSeconds() (user, sys float64) {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6, float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
}

// gsoOOB is the control message that makes one send carry payload/segment datagrams.
func gsoOOB(segment int) []byte {
	oob := make([]byte, unix.CmsgSpace(2))
	binary.NativeEndian.PutUint64(oob[0:], uint64(unix.CmsgLen(2)))
	binary.NativeEndian.PutUint32(oob[8:], unix.SOL_UDP)
	binary.NativeEndian.PutUint32(oob[12:], unix.UDP_SEGMENT)
	binary.NativeEndian.PutUint16(oob[unix.CmsgLen(0):], uint16(segment))
	return oob
}

func main() {
	flag.Parse()
	if *mode == "recvfrom" || *mode == "recvmmsg" {
		receive()
		return
	}
	send()
}

func send() {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{})
	check(err)
	_ = conn.SetWriteBuffer(4 << 20)
	addrs := make([]netip.AddrPort, *dests)
	ip := netip.MustParseAddr(*dst)
	for i := range addrs {
		addrs[i] = netip.AddrPortFrom(ip, uint16(*port+i))
	}
	payload := make([]byte, *size**frame)
	pc := ipv4.NewPacketConn(conn)
	oob := gsoOOB(*size)
	interval := time.Duration(float64(time.Second) / (float64(*rate) / float64(*frame)))
	u0, s0 := cpuSeconds()
	start := time.Now()
	deadline := start.Add(time.Duration(*seconds) * time.Second)
	var sent int
	next, d := start, 0
	for next.Before(deadline) {
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		}
		// The mmsg modes send every frame that came due while the sender slept as one call.
		due := 1
		if *mode == "mmsg" || *mode == "mmsg-gso" {
			due = min(max(1, int(time.Since(next)/interval)+1), *batch)
		}
		switch *mode {
		case "sendto":
			for range due {
				for range *frame {
					_, err = conn.WriteToUDPAddrPort(payload[:*size], addrs[d%len(addrs)])
					check(err)
				}
				d++
			}
		case "gso":
			_, _, err = conn.WriteMsgUDPAddrPort(payload, oob, addrs[d%len(addrs)])
			check(err)
			d++
		case "mmsg":
			ms := make([]ipv4.Message, 0, due**frame)
			for f := range due {
				a := net.UDPAddrFromAddrPort(addrs[(d+f)%len(addrs)])
				for range *frame {
					ms = append(ms, ipv4.Message{Buffers: [][]byte{payload[:*size]}, Addr: a})
				}
			}
			_, err = pc.WriteBatch(ms, 0)
			check(err)
			d += due
		case "mmsg-gso":
			ms := make([]ipv4.Message, 0, due)
			for f := range due {
				ms = append(ms, ipv4.Message{Buffers: [][]byte{payload}, OOB: oob, Addr: net.UDPAddrFromAddrPort(addrs[(d+f)%len(addrs)])})
			}
			_, err = pc.WriteBatch(ms, 0)
			check(err)
			d += due
		}
		sent += due * *frame
		next = next.Add(time.Duration(due) * interval)
	}
	u1, s1 := cpuSeconds()
	el := time.Since(start).Seconds()
	fmt.Printf("%-9s sent %d pkts in %.1fs (%.0f pps): cpu %.1f%% (user %.1f%% sys %.1f%%) = %.2f us/pkt\n", *mode, sent, el, float64(sent)/el,
		100*(u1+s1-u0-s0)/el, 100*(u1-u0)/el, 100*(s1-s0)/el, 1e6*(u1+s1-u0-s0)/float64(sent))
}

func receive() {
	var got atomic.Int64
	conns := make([]*net.UDPConn, *dests)
	for i := range conns {
		c, err := net.ListenUDP("udp4", &net.UDPAddr{Port: *port + i})
		check(err)
		_ = c.SetReadBuffer(8 << 20)
		conns[i] = c
	}
	u0, s0 := cpuSeconds()
	start := time.Now()
	for _, c := range conns {
		go func() {
			if *mode == "recvmmsg" {
				pc := ipv4.NewPacketConn(c)
				ms := make([]ipv4.Message, *batch)
				for i := range ms {
					ms[i].Buffers = [][]byte{make([]byte, 2048)}
				}
				for {
					n, err := pc.ReadBatch(ms, 0)
					if err != nil {
						return
					}
					got.Add(int64(n))
				}
			}
			buf := make([]byte, 2048)
			for {
				if _, _, err := c.ReadFromUDPAddrPort(buf); err != nil {
					return
				}
				got.Add(1)
			}
		}()
	}
	time.Sleep(time.Duration(*seconds) * time.Second)
	u1, s1 := cpuSeconds()
	el := time.Since(start).Seconds()
	n := got.Load()
	fmt.Printf("%-9s received %d pkts in %.1fs (%.0f pps): cpu %.1f%% (user %.1f%% sys %.1f%%) = %.2f us/pkt\n", *mode, n, el, float64(n)/el,
		100*(u1+s1-u0-s0)/el, 100*(u1-u0)/el, 100*(s1-s0)/el, 1e6*(u1+s1-u0-s0)/float64(max(n, 1)))
	os.Exit(0)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
