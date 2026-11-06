//go:build linux

package media

import (
	"cmp"
	"math/bits"
	"net"
	"net/netip"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The media socket carries every packet of every call, and one sendto or
// recvfrom per packet was a third of the node's CPU. batchConn keeps Pion's
// ICE mux unchanged and moves the syscalls behind it:
//
//   - Reads: one recvmmsg returns every datagram already waiting, and the mux
//     takes them one at a time.
//   - Writes: the mux's WriteToAddrPort copies the datagram into a queue and
//     one goroutine sends what accumulated while the forwarders ran, with one
//     sendmmsg. Datagrams for one peer that are the same size (a video frame's
//     packets) leave as one UDP_SEGMENT train, which the kernel splits after it
//     has routed and queued them once.

const (
	// batchRecv is the datagrams one recvmmsg returns at most.
	batchRecv = 32
	// batchRing is the datagrams queued for the writer. A caller that finds the
	// queue full sends it first, so a slow socket pushes back on forwarders and
	// no datagram overtakes an earlier one.
	batchRing = 256
	// gsoSegments is the kernel's limit of segments in one UDP_SEGMENT datagram.
	gsoSegments = 64
	// datagramMax is the largest datagram the queue holds. Larger ones are sent directly.
	datagramMax = 1500
)

type queued struct {
	addr netip.AddrPort
	n    int
	buf  [datagramMax]byte
}

type sendQueue [batchRing]queued

// batchConn is an IPv4 UDP socket with batched reads and writes. It implements
// net.PacketConn and Pion's AddrPortReaderWriter. Reads are for one goroutine,
// as the ICE mux's read worker is.
type batchConn struct {
	*net.UDPConn
	raw syscall.RawConn

	mu      sync.Mutex
	pending *sendQueue // filled by callers, under mu
	count   int
	wake    chan struct{}
	done    chan struct{}
	closed  atomic.Bool

	// Owned by whoever holds sendMu: the writer goroutine, or a caller that found the queue full.
	sendMu  sync.Mutex
	sending *sendQueue
	gso     bool
	order   []int32
	iov     [batchRing]unix.Iovec
	names   [batchRing]unix.RawSockaddrInet4
	control [batchRing][unix.SizeofCmsghdr + 8]byte
	out     [batchRing]unix.Mmsghdr
	// Datagrams the kernel refused. A refused datagram is lost like any UDP datagram;
	// the subscriber's NACK recovers video.
	refused atomic.Int64

	// Owned by the reading goroutine.
	rxHdr   [batchRecv]unix.Mmsghdr
	rxIov   [batchRecv]unix.Iovec
	rxNames [batchRecv]unix.RawSockaddrInet4
	rxBufs  [batchRecv][datagramMax]byte
	rxNext  int
	rxCount int
}

var _ net.PacketConn = (*batchConn)(nil)

// newMediaConn wraps conn for batched I/O when it is an IPv4 socket on Linux.
func newMediaConn(conn *net.UDPConn) net.PacketConn {
	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || local.IP.To4() == nil {
		return conn
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return conn
	}
	c := &batchConn{UDPConn: conn, raw: raw, pending: new(sendQueue), sending: new(sendQueue),
		wake: make(chan struct{}, 1), done: make(chan struct{})}
	c.gso = supportsSegmentation(raw)
	for i := range c.rxHdr {
		c.rxIov[i] = unix.Iovec{Base: &c.rxBufs[i][0]}
		c.rxIov[i].SetLen(datagramMax)
		c.rxHdr[i].Hdr.Name = (*byte)(unsafe.Pointer(&c.rxNames[i]))
		c.rxHdr[i].Hdr.Iov = &c.rxIov[i]
		c.rxHdr[i].Hdr.SetIovlen(1)
	}
	go c.write()
	return c
}

func supportsSegmentation(raw syscall.RawConn) bool {
	var err error
	if controlErr := raw.Control(func(fd uintptr) {
		_, err = unix.GetsockoptInt(int(fd), unix.SOL_UDP, unix.UDP_SEGMENT)
	}); controlErr != nil {
		return false
	}
	return err == nil
}

func portOf(name *unix.RawSockaddrInet4) netip.AddrPort {
	return netip.AddrPortFrom(netip.AddrFrom4(name.Addr), bits.ReverseBytes16(name.Port))
}

// ReadFromAddrPort returns the next datagram, calling recvmmsg when the last batch is used up.
func (c *batchConn) ReadFromAddrPort(b []byte) (int, netip.AddrPort, error) {
	if c.rxNext == c.rxCount {
		if err := c.receive(); err != nil {
			return 0, netip.AddrPort{}, err
		}
	}
	i := c.rxNext
	c.rxNext++
	n := copy(b, c.rxBufs[i][:c.rxHdr[i].Len])
	return n, portOf(&c.rxNames[i]), nil
}

func (c *batchConn) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := c.ReadFromAddrPort(b)
	return n, net.UDPAddrFromAddrPort(addr), err
}

func (c *batchConn) receive() error {
	for i := range c.rxHdr {
		c.rxHdr[i].Hdr.Namelen = unix.SizeofSockaddrInet4
		c.rxHdr[i].Len = 0
	}
	var count int
	var errno syscall.Errno
	err := c.raw.Read(func(fd uintptr) bool {
		r, _, e := unix.Syscall6(unix.SYS_RECVMMSG, fd, uintptr(unsafe.Pointer(&c.rxHdr[0])), batchRecv, unix.MSG_DONTWAIT, 0, 0)
		if e == unix.EAGAIN {
			return false
		}
		count, errno = int(r), e
		return true
	})
	if err != nil {
		return err
	}
	if errno != 0 {
		return errno
	}
	c.rxNext, c.rxCount = 0, count
	return nil
}

// WriteToAddrPort queues a copy of b: Pion reuses b once this returns.
func (c *batchConn) WriteToAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	if len(b) > datagramMax || !addr.Addr().Is4() && !addr.Addr().Is4In6() {
		return c.UDPConn.WriteToUDPAddrPort(b, addr)
	}
	c.mu.Lock()
	for c.count == batchRing {
		c.mu.Unlock()
		c.flushPending()
		c.mu.Lock()
	}
	entry := &c.pending[c.count]
	entry.addr, entry.n = netip.AddrPortFrom(addr.Addr().Unmap(), addr.Port()), copy(entry.buf[:], b)
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

// Close stops the writer, drops what is still queued, and closes the socket.
func (c *batchConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		close(c.done)
	}
	return c.UDPConn.Close()
}

func (c *batchConn) write() {
	for {
		select {
		case <-c.done:
			return
		case <-c.wake:
		}
		// Let the goroutines that are ready queue their datagrams first, so one
		// system call carries more of them.
		runtime.Gosched()
		c.flushPending()
	}
}

// flushPending sends everything queued so far. Calls are serialized, so queues
// leave in the order they filled.
func (c *batchConn) flushPending() {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	c.mu.Lock()
	c.pending, c.sending = c.sending, c.pending
	n := c.count
	c.count = 0
	c.mu.Unlock()
	c.flush(c.sending[:n])
}

// setSegmentSize is the control message that makes one sendmsg carry size-byte datagrams.
func setSegmentSize(control *[unix.SizeofCmsghdr + 8]byte, size int) {
	header := (*unix.Cmsghdr)(unsafe.Pointer(control))
	header.Level, header.Type = unix.SOL_UDP, unix.UDP_SEGMENT
	header.SetLen(unix.CmsgLen(2))
	*(*uint16)(unsafe.Pointer(&control[unix.CmsgLen(0)])) = uint16(size)
}

// flush sends the entries, each peer's datagrams in the order they were queued.
func (c *batchConn) flush(entries []queued) {
	messages := c.plan(entries)
	for sent := 0; sent < messages; {
		n, errno := c.sendmmsg(c.out[sent:messages])
		if errno != 0 {
			c.sendEach(&c.out[sent])
			// A path that refuses segmentation offload gets plain datagrams from now on.
			if c.gso && (errno == unix.EIO || errno == unix.EINVAL || errno == unix.EOPNOTSUPP) {
				c.gso = false
			}
			n = 1
		}
		sent += n
	}
}

// sendEach sends the datagrams of a message the kernel refused one by one, so one
// bad train costs only the datagrams that are really refused.
func (c *batchConn) sendEach(message *unix.Mmsghdr) {
	peer := portOf((*unix.RawSockaddrInet4)(unsafe.Pointer(message.Hdr.Name)))
	for _, iov := range unsafe.Slice(message.Hdr.Iov, message.Hdr.Iovlen) {
		if _, err := c.UDPConn.WriteToUDPAddrPort(unsafe.Slice(iov.Base, iov.Len), peer); err != nil {
			c.refused.Add(1)
		}
	}
}

// plan fills c.out with one message per run of same-size datagrams to one peer,
// or one per datagram when segmentation is off, and returns the message count.
func (c *batchConn) plan(entries []queued) int {
	c.order = c.order[:0]
	for i := range entries {
		c.order = append(c.order, int32(i))
	}
	slices.SortStableFunc(c.order, func(a, b int32) int {
		if byIP := entries[a].addr.Addr().Compare(entries[b].addr.Addr()); byIP != 0 {
			return byIP
		}
		return cmp.Compare(entries[a].addr.Port(), entries[b].addr.Port())
	})
	for i, index := range c.order {
		c.iov[i] = unix.Iovec{Base: &entries[index].buf[0]}
		c.iov[i].SetLen(entries[index].n)
	}
	messages := 0
	for i := 0; i < len(c.order); {
		first := &entries[c.order[i]]
		run := 1
		if c.gso {
			// The kernel splits a train into equal segments plus a shorter last one.
			for i+run < len(c.order) && run < gsoSegments {
				next := &entries[c.order[i+run]]
				if next.addr != first.addr || next.n > first.n || entries[c.order[i+run-1]].n != first.n {
					break
				}
				run++
			}
		}
		name := &c.names[messages]
		*name = unix.RawSockaddrInet4{Family: unix.AF_INET, Port: bits.ReverseBytes16(first.addr.Port()), Addr: first.addr.Addr().As4()}
		message := &c.out[messages].Hdr
		*message = unix.Msghdr{Name: (*byte)(unsafe.Pointer(name)), Iov: &c.iov[i]}
		message.Namelen = unix.SizeofSockaddrInet4
		message.SetIovlen(run)
		if run > 1 {
			setSegmentSize(&c.control[messages], first.n)
			message.Control = &c.control[messages][0]
			message.SetControllen(unix.CmsgSpace(2))
		}
		messages++
		i += run
	}
	return messages
}

// sendmmsg sends messages and returns how many went out; errno is set when the first one failed.
func (c *batchConn) sendmmsg(messages []unix.Mmsghdr) (sent int, errno syscall.Errno) {
	err := c.raw.Write(func(fd uintptr) bool {
		r, _, e := unix.Syscall6(unix.SYS_SENDMMSG, fd, uintptr(unsafe.Pointer(&messages[0])), uintptr(len(messages)), 0, 0, 0)
		if e == unix.EAGAIN {
			return false
		}
		sent, errno = int(r), e
		return true
	})
	if err != nil {
		// A closed socket: nothing more can go out.
		return len(messages), 0
	}
	return sent, errno
}
