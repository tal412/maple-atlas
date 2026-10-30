package main

import (
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/stun/v4"
)

// sniffConn watches the shared ICE socket for the phone's first connectivity
// check. Browsers never reveal their ICE username to a page, but every check the
// phone sends carries it ("macUfrag:phoneUfrag"). A check only counts when its
// MESSAGE-INTEGRITY verifies with the Mac's ICE password, which exists only in
// the QR, so another device on the network cannot claim the session.
//
// Each distinct phone username is reported once: a phone that comes back after
// being paused opens a new peer connection with a new username.
type sniffConn struct {
	net.PacketConn
	localUfrag, localPwd string
	mu                   sync.Mutex
	last                 string
	found                chan string
	// contact is told (at most every few seconds) that a phone holding this code
	// reached this computer, even before its check verifies: that tells a blocked
	// network apart from a phone that never tried.
	contact     func(from string)
	contactAt   time.Time
	contactFrom string
}

// lastContact: when and from where a phone holding this code last reached this computer
// (zero time: never).
func (c *sniffConn) lastContact() (time.Time, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.contactAt, c.contactFrom
}

func newSniffConn(conn net.PacketConn, ufrag, pwd string) *sniffConn {
	return &sniffConn{PacketConn: conn, localUfrag: ufrag, localPwd: pwd, found: make(chan string, 4)}
}

func (c *sniffConn) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := c.PacketConn.ReadFrom(b)
	if err == nil && n > 0 {
		c.inspect(b[:n], addr)
	}
	return n, addr, err
}

func (c *sniffConn) inspect(packet []byte, from net.Addr) {
	if !stun.IsMessage(packet) {
		return
	}
	m := &stun.Message{Raw: append([]byte(nil), packet...)}
	if m.Decode() != nil || m.Type != stun.BindingRequest {
		return
	}
	var username stun.Username
	if username.GetFrom(m) != nil {
		return
	}
	local, remote, ok := strings.Cut(username.String(), ":")
	if !ok || local != c.localUfrag || len(remote) < 4 || len(remote) > 256 {
		return
	}
	c.mu.Lock()
	if c.contact != nil && time.Since(c.contactAt) > 3*time.Second {
		c.contactAt = time.Now()
		host, _, _ := net.SplitHostPort(from.String())
		c.contactFrom = host
		go c.contact(host)
	}
	c.mu.Unlock()
	if stun.MessageIntegrity([]byte(c.localPwd)).Check(m) != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if remote == c.last {
		return
	}
	c.last = remote
	select {
	case c.found <- remote:
	default: // a waiting link takes the newest one; stale entries are drained below
	}
}
