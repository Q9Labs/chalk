//go:build linux

package media

import (
	"encoding/binary"
	"math/bits"
	"net"
	"net/netip"
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
//
// Both batch calls are raw system calls. They never block (MSG_DONTWAIT; EAGAIN
// parks on the poller), and a plain system call tells the scheduler it may block:
// it wakes the runtime's monitor thread, which then polls every 20 µs for a while
// to take the processor back. On a one-vCPU node those wakeups cost more CPU than
// the handoff could ever save.

const (
	// batchRecv is the datagrams one recvmmsg returns at most.
	batchRecv = 32
	// videoRing and audioRing are the datagrams queued for the writer, per class. The one
	// writer's sendmmsg sometimes stalls for 5 to 25 ms, mostly when the host steals its vCPU,
	// and 2048 video datagrams hold a 25 ms stall at 80,000 packets/s, which is as much as a
	// 2 vCPU node carries. A caller never waits for space: a full ring overwrites its oldest
	// datagram and counts it, so a stalled socket costs old video and never stops a forwarder.
	// Audio, RTCP and the connection's own STUN and DTLS have a ring of their own, so a video
	// backlog never displaces them, and they leave first.
	videoRing = 2048
	audioRing = 1024
	// batchRing is the datagrams both rings hold, which sizes the writer's send arrays.
	batchRing = videoRing + audioRing
	// gsoSegments is the kernel's limit of segments in one UDP_SEGMENT datagram.
	gsoSegments = 64
	// gsoPayloadMax keeps a train under the 65507 bytes a UDP datagram can carry; a larger one
	// fails with EINVAL, which would switch segmentation off for the socket.
	gsoPayloadMax = 65000
	// datagramMax is the largest datagram the send queue holds. Larger ones are sent directly.
	datagramMax = 1500
	// receiveMax is the read buffer for one datagram: any SRTP datagram on a 1500-byte path,
	// with room for jumbo frames on loopback. Longer ones arrive truncated and are dropped.
	receiveMax = 2048
)

// markVideo adds or removes an SSRC of a video stream the node sends: VP8, its RTX repairs and
// probe padding. The class is by SSRC and not by payload type, because a browser's offer picks the
// payload types (Firefox negotiates VP8 as 120 and RTX as 124), so the node cannot know them.
func (c *batchConn) markVideo(ssrc uint32, on bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if on {
		c.video[ssrc] = struct{}{}
	} else {
		delete(c.video, ssrc)
	}
}

// isVideo reports whether b is an RTP packet of a marked video SSRC. The RTP header is not
// encrypted, so the SSRC is readable on an SRTP packet. Types 64 to 95 are the range RTCP shares
// with RTP on one port (RTCP types 200 to 207 read as 72 to 79); they keep an RTCP packet from being
// read as RTP. The caller holds c.mu.
func (c *batchConn) isVideo(b []byte) bool {
	if len(b) < 12 || b[0]>>6 != 2 || b[1]&0x7f >= 64 && b[1]&0x7f < 96 {
		return false
	}
	_, video := c.video[binary.BigEndian.Uint32(b[8:])]
	return video
}

// batchConn is an IPv4 UDP socket with batched reads and writes. It implements
// net.PacketConn and Pion's AddrPortReaderWriter. Reads are for one goroutine,
// as the ICE mux's read worker is.
type batchConn struct {
	*net.UDPConn
	raw syscall.RawConn

	// mu guards pending, video and closed. It is never held across a system call.
	mu      sync.Mutex
	pending *sendQueue // filled by callers
	video   map[uint32]struct{}
	closed  bool
	wake    chan struct{}
	done    chan struct{}

	// Owned by the writer goroutine, the only one that sends from the queue.
	sending *sendQueue
	gso     bool
	// stalled holds the writer before it sends what it took, so a test can stall the socket.
	stalled func()
	entries []*queued
	order   []int32
	iov     [batchRing]unix.Iovec
	names   [batchRing]unix.RawSockaddrInet4
	control [batchRing][unix.SizeofCmsghdr + 8]byte
	out     [batchRing]unix.Mmsghdr
	// Datagrams the kernel refused. A refused datagram is lost like any UDP datagram;
	// the subscriber's NACK recovers video.
	refused atomic.Int64
	// Datagrams larger than a read buffer, which the kernel cut short. They are dropped.
	truncated atomic.Int64
	// Datagrams overwritten in a full ring because the writer could not keep up, by class.
	droppedAudio, droppedVideo atomic.Int64

	// Owned by the reading goroutine.
	rxHdr   [batchRecv]unix.Mmsghdr
	rxIov   [batchRecv]unix.Iovec
	rxNames [batchRecv]unix.RawSockaddrInet4
	rxBufs  [batchRecv][receiveMax]byte
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
	c := &batchConn{UDPConn: conn, raw: raw, pending: newSendQueue(), sending: newSendQueue(), video: map[uint32]struct{}{},
		entries: make([]*queued, 0, batchRing), wake: make(chan struct{}, 1), done: make(chan struct{})}
	c.gso = supportsSegmentation(raw)
	for i := range c.rxHdr {
		c.rxIov[i] = unix.Iovec{Base: &c.rxBufs[i][0]}
		c.rxIov[i].SetLen(receiveMax)
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
	for {
		if c.rxNext == c.rxCount {
			if err := c.receive(); err != nil {
				return 0, netip.AddrPort{}, err
			}
		}
		i := c.rxNext
		c.rxNext++
		if c.rxHdr[i].Hdr.Flags&unix.MSG_TRUNC != 0 {
			c.truncated.Add(1)
			continue
		}
		n := copy(b, c.rxBufs[i][:c.rxHdr[i].Len])
		return n, portOf(&c.rxNames[i]), nil
	}
}

// counters reports the datagrams the kernel refused to send, the ones cut short on receipt, and
// the audio-class and video datagrams dropped from a full send ring.
func (c *batchConn) counters() (refused, truncated, droppedAudio, droppedVideo uint64) {
	return uint64(c.refused.Load()), uint64(c.truncated.Load()), uint64(c.droppedAudio.Load()), uint64(c.droppedVideo.Load())
}

func (c *batchConn) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := c.ReadFromAddrPort(b)
	return n, net.UDPAddrFromAddrPort(addr), err
}

func (c *batchConn) receive() error {
	for i := range c.rxHdr {
		c.rxHdr[i].Hdr.Namelen = unix.SizeofSockaddrInet4
		c.rxHdr[i].Len = 0
		c.rxHdr[i].Hdr.Flags = 0
	}
	var count int
	var errno syscall.Errno
	err := c.raw.Read(func(fd uintptr) bool {
		r, _, e := unix.RawSyscall6(unix.SYS_RECVMMSG, fd, uintptr(unsafe.Pointer(&c.rxHdr[0])), batchRecv, unix.MSG_DONTWAIT, 0, 0)
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

// Close stops the writer, drops what is still queued, and closes the socket.
func (c *batchConn) Close() error {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.done)
	}
	c.mu.Unlock()
	return c.UDPConn.Close()
}
