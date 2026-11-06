//go:build linux

package media

import (
	"cmp"
	"encoding/binary"
	"net"
	"net/netip"
	"os"
	"slices"
	"sync"
	"sync/atomic"

	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

// Profiling scratch: not for master. batchConn replaces one sendto per packet
// with one sendmmsg per wake-up, and sends consecutive equal-size packets to
// one peer as a single UDP_SEGMENT (GSO) datagram train. Pion's ICE mux calls
// WriteToAddrPort per packet; the packets are copied, queued, and written by one
// goroutine that sends whatever accumulated while the forwarders ran.

const (
	batchRing    = 256
	batchMaxSegs = 64
	batchMaxSize = 1500
)

type batchEntry struct {
	addr netip.AddrPort
	n    int
	buf  [batchMaxSize]byte
}

type batchConn struct {
	*net.UDPConn
	pc  *ipv4.PacketConn
	gso bool

	mu      sync.Mutex
	pending *[batchRing]batchEntry
	count   int
	wake    chan struct{}
	done    chan struct{}
	closed  atomic.Bool

	spare *[batchRing]batchEntry
	order []int
	msgs  []ipv4.Message
	addrs map[netip.AddrPort]*net.UDPAddr
	oob   map[int][]byte
}

// newMuxConn wraps the node's UDP socket when SFU_BATCH_UDP is "mmsg" (sendmmsg) or "gso" (sendmmsg plus UDP_SEGMENT).
func newMuxConn(conn *net.UDPConn) net.PacketConn {
	switch os.Getenv("SFU_BATCH_UDP") {
	case "mmsg":
		return newBatchConn(conn, false)
	case "gso":
		return newBatchConn(conn, true)
	}
	return conn
}

func newBatchConn(conn *net.UDPConn, gso bool) *batchConn {
	c := &batchConn{UDPConn: conn, pc: ipv4.NewPacketConn(conn), gso: gso,
		pending: new([batchRing]batchEntry), spare: new([batchRing]batchEntry),
		wake: make(chan struct{}, 1), done: make(chan struct{}),
		addrs: map[netip.AddrPort]*net.UDPAddr{}, oob: map[int][]byte{}}
	go c.run()
	return c
}

// WriteToAddrPort copies the packet into the queue; Pion reuses its buffer when this returns.
func (c *batchConn) WriteToAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	if len(b) > batchMaxSize {
		return c.UDPConn.WriteToUDPAddrPort(b, addr)
	}
	c.mu.Lock()
	if c.count == batchRing {
		c.mu.Unlock()
		return c.UDPConn.WriteToUDPAddrPort(b, addr)
	}
	e := &c.pending[c.count]
	e.addr, e.n = addr, copy(e.buf[:], b)
	c.count++
	first := c.count == 1
	c.mu.Unlock()
	if first {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	return len(b), nil
}

func (c *batchConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	udp, ok := addr.(*net.UDPAddr)
	if !ok {
		return c.UDPConn.WriteTo(b, addr)
	}
	return c.WriteToAddrPort(b, udp.AddrPort())
}

func (c *batchConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		close(c.done)
	}
	return c.UDPConn.Close()
}

func (c *batchConn) run() {
	for {
		select {
		case <-c.done:
			return
		case <-c.wake:
		}
		c.mu.Lock()
		batch, n := c.pending, c.count
		c.pending, c.spare, c.count = c.spare, batch, 0
		c.mu.Unlock()
		c.flush(batch[:n])
	}
}

func (c *batchConn) segmentOOB(size int) []byte {
	if oob, ok := c.oob[size]; ok {
		return oob
	}
	oob := make([]byte, unix.CmsgSpace(2))
	binary.NativeEndian.PutUint64(oob[0:], uint64(unix.CmsgLen(2)))
	binary.NativeEndian.PutUint32(oob[8:], unix.SOL_UDP)
	binary.NativeEndian.PutUint32(oob[12:], unix.UDP_SEGMENT)
	binary.NativeEndian.PutUint16(oob[unix.CmsgLen(0):], uint16(size))
	c.oob[size] = oob
	return oob
}

func (c *batchConn) udpAddr(a netip.AddrPort) *net.UDPAddr {
	if u, ok := c.addrs[a]; ok {
		return u
	}
	if len(c.addrs) > 4096 {
		clear(c.addrs)
	}
	u := net.UDPAddrFromAddrPort(a)
	c.addrs[a] = u
	return u
}

// flush sends the entries grouped by peer, keeping each peer's order.
func (c *batchConn) flush(entries []batchEntry) {
	c.order = c.order[:0]
	for i := range entries {
		c.order = append(c.order, i)
	}
	slices.SortStableFunc(c.order, func(a, b int) int {
		if byIP := entries[a].addr.Addr().Compare(entries[b].addr.Addr()); byIP != 0 {
			return byIP
		}
		return cmp.Compare(entries[a].addr.Port(), entries[b].addr.Port())
	})
	c.msgs = c.msgs[:0]
	for i := 0; i < len(c.order); {
		first := &entries[c.order[i]]
		j, segs := i+1, 1
		if c.gso {
			for ; j < len(c.order) && segs < batchMaxSegs; j++ {
				next, prev := &entries[c.order[j]], &entries[c.order[j-1]]
				if next.addr != first.addr || prev.n != first.n || next.n > first.n {
					break
				}
				segs++
			}
		}
		buffers := make([][]byte, 0, segs)
		for _, index := range c.order[i : i+segs] {
			buffers = append(buffers, entries[index].buf[:entries[index].n])
		}
		message := ipv4.Message{Buffers: buffers, Addr: c.udpAddr(first.addr)}
		if segs > 1 {
			message.OOB = c.segmentOOB(first.n)
		}
		c.msgs = append(c.msgs, message)
		i += segs
	}
	for sent := 0; sent < len(c.msgs); {
		n, err := c.pc.WriteBatch(c.msgs[sent:], 0)
		if err != nil {
			// Drop the message that failed, as a lost datagram; NACK recovers video.
			n++
		}
		sent += n
	}
}
