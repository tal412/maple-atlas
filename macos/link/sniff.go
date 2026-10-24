package main

import (
	"net"
	"strings"
	"sync"

	"github.com/pion/stun/v4"
)

// sniffConn watches the shared ICE socket for the phone's first connectivity
// check. Browsers never reveal their ICE username to a page, but every check the
// phone sends carries it ("macUfrag:phoneUfrag"). A check only counts when its
// MESSAGE-INTEGRITY verifies with the Mac's ICE password, which exists only in
// the QR, so another device on the network cannot claim the session.
type sniffConn struct {
	net.PacketConn
	localUfrag, localPwd string
	once                 sync.Once
	found                chan string
}

func newSniffConn(conn net.PacketConn, ufrag, pwd string) *sniffConn {
	return &sniffConn{PacketConn: conn, localUfrag: ufrag, localPwd: pwd, found: make(chan string, 1)}
}

func (c *sniffConn) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := c.PacketConn.ReadFrom(b)
	if err == nil && n > 0 {
		c.inspect(b[:n])
	}
	return n, addr, err
}

func (c *sniffConn) inspect(packet []byte) {
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
	if stun.MessageIntegrity([]byte(c.localPwd)).Check(m) != nil {
		return
	}
	c.once.Do(func() { c.found <- remote })
}
