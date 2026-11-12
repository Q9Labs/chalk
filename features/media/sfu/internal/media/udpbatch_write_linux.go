package media

import (
	"cmp"
	"math/bits"
	"net"
	"net/netip"
	"runtime"
	"slices"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// WriteToAddrPort queues a copy of b: Pion reuses b once this returns. It never waits for the
// socket: when the ring of b's class is full, the ring's oldest datagram is dropped for it.
func (c *batchConn) WriteToAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	if len(b) > datagramMax || !addr.Addr().Is4() && !addr.Addr().Is4In6() {
		return c.UDPConn.WriteToUDPAddrPort(b, addr)
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return 0, net.ErrClosed
	}
	queue := &c.pending.audio
	dropCounter := &c.droppedAudio
	if c.isVideo(b) {
		queue, dropCounter = &c.pending.video, &c.droppedVideo
	}
	entry, dropped := queue.claim()
	entry.addr, entry.n = netip.AddrPortFrom(addr.Addr().Unmap(), addr.Port()), copy(entry.buf[:], b)
	first := c.pending.len() == 1
	c.mu.Unlock()
	if dropped {
		dropCounter.Add(1)
	}
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
		for c.sendQueued() {
		}
	}
}

// sendQueued takes the queue and sends it with no lock held, so forwarders can fill the
// other queue meanwhile. It reports whether there was anything to send.
func (c *batchConn) sendQueued() bool {
	c.mu.Lock()
	if c.pending.len() == 0 || c.closed {
		c.mu.Unlock()
		return false
	}
	c.pending, c.sending = c.sending, c.pending
	c.pending.audio.head, c.pending.audio.count = 0, 0
	c.pending.video.head, c.pending.video.count = 0, 0
	c.mu.Unlock()
	if c.stalled != nil {
		c.stalled()
	}
	// Audio-class datagrams go first, each ring oldest first. They leave in a flush of their own:
	// plan sorts a flush by peer, so one flush would send a peer's video before another peer's audio.
	for _, queue := range []*ring{&c.sending.audio, &c.sending.video} {
		c.entries = c.entries[:0]
		for i := range queue.count {
			c.entries = append(c.entries, queue.at(i))
		}
		c.flush(c.entries)
	}
	return true
}

// setSegmentSize is the control message that makes one sendmsg carry size-byte datagrams.
func setSegmentSize(control *[unix.SizeofCmsghdr + 8]byte, size int) {
	header := (*unix.Cmsghdr)(unsafe.Pointer(control))
	header.Level, header.Type = unix.SOL_UDP, unix.UDP_SEGMENT
	header.SetLen(unix.CmsgLen(2))
	*(*uint16)(unsafe.Pointer(&control[unix.CmsgLen(0)])) = uint16(size)
}

// flush sends the entries, each peer's datagrams in the order they were queued.
func (c *batchConn) flush(entries []*queued) {
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
func (c *batchConn) plan(entries []*queued) int {
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
		run := c.runAt(entries, i)
		c.message(messages, entries[c.order[i]], i, run)
		messages++
		i += run
	}
	return messages
}

// runAt is how many datagrams from c.order[i] go out as one segmented message.
func (c *batchConn) runAt(entries []*queued, i int) int {
	first := entries[c.order[i]]
	run := 1
	if !c.gso {
		return run
	}
	// The kernel splits a train into equal segments plus a shorter last one.
	for i+run < len(c.order) && run < gsoSegments && (run+1)*first.n <= gsoPayloadMax {
		next := entries[c.order[i+run]]
		if next.addr != first.addr || next.n > first.n || entries[c.order[i+run-1]].n != first.n {
			break
		}
		run++
	}
	return run
}

// message fills c.out[messages] with the run of datagrams that starts at iovec i.
func (c *batchConn) message(messages int, first *queued, i, run int) {
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
}

// sendmmsg sends messages and returns how many went out; errno is set when the first one failed.
func (c *batchConn) sendmmsg(messages []unix.Mmsghdr) (sent int, errno syscall.Errno) {
	err := c.raw.Write(func(fd uintptr) bool {
		r, _, e := unix.RawSyscall6(unix.SYS_SENDMMSG, fd, uintptr(unsafe.Pointer(&messages[0])), uintptr(len(messages)), unix.MSG_DONTWAIT, 0, 0)
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
