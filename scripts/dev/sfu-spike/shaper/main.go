// Userspace stand-in for `tc netem` on kernels without sch_netem (Instabox). It forwards Ethernet frames between two
// interfaces and delays, jitters, drops and rate-limits IPv4 UDP only (DNS and NTP ports excluded), like the run-5 rig.
// The profile is read from a JSON control file: {"aToB": "delay 75ms 15ms loss 2%", "bToA": "..."}; {} passes everything.
package main

import (
	"container/heap"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type spec struct {
	delay, jitter time.Duration
	loss          float64
	rateBps       float64
	limit         int
}

func parseSpec(text string) (spec, error) {
	s := spec{limit: 1000}
	f := strings.Fields(text)
	for i := 0; i < len(f); i++ {
		switch f[i] {
		case "delay":
			d, err := time.ParseDuration(f[i+1])
			if err != nil {
				return s, err
			}
			s.delay = d
			i++
			if i+1 < len(f) && strings.HasSuffix(f[i+1], "ms") {
				j, err := time.ParseDuration(f[i+1])
				if err != nil {
					return s, err
				}
				s.jitter = j
				i++
			}
		case "loss":
			v, err := strconv.ParseFloat(strings.TrimSuffix(f[i+1], "%"), 64)
			if err != nil {
				return s, err
			}
			s.loss = v / 100
			i++
		case "rate":
			v := strings.TrimSuffix(f[i+1], "mbit")
			m, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return s, err
			}
			s.rateBps = m * 1e6
			i++
		case "limit":
			n, err := strconv.Atoi(f[i+1])
			if err != nil {
				return s, err
			}
			s.limit = n
			i++
		default:
			return s, fmt.Errorf("unknown token %q", f[i])
		}
	}
	return s, nil
}

type item struct {
	at    time.Time
	frame []byte
}
type queue []item

func (q queue) Len() int            { return len(q) }
func (q queue) Less(i, j int) bool  { return q[i].at.Before(q[j].at) }
func (q queue) Swap(i, j int)       { q[i], q[j] = q[j], q[i] }
func (q *queue) Push(x interface{}) { *q = append(*q, x.(item)) }
func (q *queue) Pop() interface{} {
	old := *q
	n := len(old)
	x := old[n-1]
	*q = old[:n-1]
	return x
}

type direction struct {
	name           string
	in, out        int
	outIf          int
	mu             sync.Mutex
	wake           chan struct{}
	q              queue
	cur            atomic.Value // spec
	active         atomic.Bool
	lastEnd        time.Time
	rng            *rand.Rand
	packets, drops atomic.Int64
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

func openRaw(name string) (int, int) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		log.Fatal(err)
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(syscall.ETH_P_ALL)))
	if err != nil {
		log.Fatal(err)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(syscall.ETH_P_ALL), Ifindex: ifc.Index}); err != nil {
		log.Fatal(err)
	}
	_ = syscall.SetsockoptInt(fd, 263, 23, 1) // SOL_PACKET, PACKET_IGNORE_OUTGOING
	_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 8<<20)
	return fd, ifc.Index
}

// shapedUDP reports whether the frame is IPv4 UDP outside the DNS and NTP ports.
func shapedUDP(frame []byte) bool {
	if len(frame) < 14+20+8 || binary.BigEndian.Uint16(frame[12:14]) != 0x0800 {
		return false
	}
	ihl := int(frame[14]&0x0f) * 4
	if frame[14+9] != 17 || len(frame) < 14+ihl+8 {
		return false
	}
	src := binary.BigEndian.Uint16(frame[14+ihl:])
	dst := binary.BigEndian.Uint16(frame[14+ihl+2:])
	for _, p := range []uint16{53, 123} {
		if src == p || dst == p {
			return false
		}
	}
	return true
}

// udpPorts returns the UDP source and destination ports of an IPv4 UDP frame.
func udpPorts(frame []byte) (uint16, uint16, bool) {
	if len(frame) < 14+20+8 || binary.BigEndian.Uint16(frame[12:14]) != 0x0800 {
		return 0, 0, false
	}
	ihl := int(frame[14]&0x0f) * 4
	if frame[14+9] != 17 || len(frame) < 14+ihl+8 {
		return 0, 0, false
	}
	return binary.BigEndian.Uint16(frame[14+ihl:]), binary.BigEndian.Uint16(frame[14+ihl+2:]), true
}

// blackholed holds the UDP ports whose traffic is dropped in both directions (a publisher's network drop).
var blackholed atomic.Value // map[uint16]bool
var blackholedPackets atomic.Int64

func (d *direction) send(frame []byte) {
	_ = syscall.Sendto(d.out, frame, 0, &syscall.SockaddrLinklayer{Ifindex: d.outIf, Halen: 6})
}

func (d *direction) reader() {
	buf := make([]byte, 65536)
	for {
		n, from, err := syscall.Recvfrom(d.in, buf, 0)
		if err != nil {
			log.Fatal(err)
		}
		if ll, ok := from.(*syscall.SockaddrLinklayer); ok && ll.Pkttype == syscall.PACKET_OUTGOING {
			continue
		}
		frame := make([]byte, n)
		copy(frame, buf[:n])
		if holes, _ := blackholed.Load().(map[uint16]bool); len(holes) > 0 {
			if src, dst, ok := udpPorts(frame); ok && (holes[src] || holes[dst]) {
				blackholedPackets.Add(1)
				continue
			}
		}
		if !d.active.Load() || !shapedUDP(frame) {
			d.send(frame)
			continue
		}
		s := d.cur.Load().(spec)
		d.packets.Add(1)
		now := time.Now()
		d.mu.Lock()
		if d.rng.Float64() < s.loss || len(d.q) >= s.limit {
			d.mu.Unlock()
			d.drops.Add(1)
			continue
		}
		at := now.Add(s.delay)
		if s.jitter > 0 {
			at = at.Add(time.Duration((d.rng.Float64()*2 - 1) * float64(s.jitter)))
		}
		if s.rateBps > 0 {
			if d.lastEnd.After(at) {
				at = d.lastEnd
			}
			at = at.Add(time.Duration(float64(n*8) / s.rateBps * float64(time.Second)))
			d.lastEnd = at
		}
		heap.Push(&d.q, item{at: at, frame: frame})
		d.mu.Unlock()
		select {
		case d.wake <- struct{}{}:
		default:
		}
	}
}

func (d *direction) sender() {
	timer := time.NewTimer(time.Hour)
	for {
		d.mu.Lock()
		var wait time.Duration = time.Hour
		for len(d.q) > 0 {
			head := d.q[0]
			if until := time.Until(head.at); until > 0 {
				wait = until
				break
			}
			heap.Pop(&d.q)
			d.mu.Unlock()
			d.send(head.frame)
			d.mu.Lock()
		}
		d.mu.Unlock()
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
		select {
		case <-timer.C:
		case <-d.wake:
		}
	}
}

type control struct {
	AToB      string `json:"aToB"`
	BToA      string `json:"bToA"`
	DropPorts []int  `json:"dropPorts"`
}

func apply(d *direction, text string) {
	if text == "" {
		d.active.Store(false)
		return
	}
	s, err := parseSpec(text)
	if err != nil {
		log.Printf("bad spec %q: %v", text, err)
		return
	}
	d.mu.Lock()
	d.lastEnd = time.Time{}
	d.mu.Unlock()
	d.cur.Store(s)
	d.active.Store(true)
}

func main() {
	a := flag.String("a", "", "client-side interface")
	b := flag.String("b", "", "server-side interface")
	ctl := flag.String("control", "/run/shaper.json", "control file")
	stats := flag.String("stats", "/run/shaper-stats.json", "stats file")
	flag.Parse()
	fa, ia := openRaw(*a)
	fb, ib := openRaw(*b)
	ab := &direction{name: "aToB", in: fa, out: fb, outIf: ib, wake: make(chan struct{}, 1), rng: rand.New(rand.NewSource(1))}
	ba := &direction{name: "bToA", in: fb, out: fa, outIf: ia, wake: make(chan struct{}, 1), rng: rand.New(rand.NewSource(2))}
	ab.cur.Store(spec{})
	ba.cur.Store(spec{})
	for _, d := range []*direction{ab, ba} {
		go d.reader()
		go d.sender()
	}
	var last time.Time
	for {
		if st, err := os.Stat(*ctl); err == nil && st.ModTime() != last {
			last = st.ModTime()
			var c control
			if raw, err := os.ReadFile(*ctl); err == nil && json.Unmarshal(raw, &c) == nil {
				holes := map[uint16]bool{}
				for _, port := range c.DropPorts {
					holes[uint16(port)] = true
				}
				blackholed.Store(holes)
				apply(ab, c.AToB)
				apply(ba, c.BToA)
				ab.packets.Store(0)
				ab.drops.Store(0)
				ba.packets.Store(0)
				ba.drops.Store(0)
				log.Printf("profile: %+v", c)
			}
		}
		out := fmt.Sprintf(`{"packets":%d,"dropped":%d,"aToB":[%d,%d],"bToA":[%d,%d],"blackholed":%d}`, ab.packets.Load()+ba.packets.Load(), ab.drops.Load()+ba.drops.Load(), ab.packets.Load(), ab.drops.Load(), ba.packets.Load(), ba.drops.Load(), blackholedPackets.Load())
		_ = os.WriteFile(*stats, []byte(out), 0o644)
		time.Sleep(200 * time.Millisecond)
	}
}
