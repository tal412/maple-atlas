package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

const (
	pairingTTL     = 10 * time.Minute
	connectTimeout = 25 * time.Second
	verifyTimeout  = 7 * time.Second
	pingEvery      = 3 * time.Second
	quietAfter     = 9 * time.Second
	failAfter      = 20 * time.Second
	channelLabel   = "maple-atlas"
)

// session serves one pairing identity (see identity.go): the same socket, ICE
// username and password, DTLS certificate and QR secret for its whole life, so the
// phone comes back after Android pauses it, or after either side restarts, with the
// code it already has. Each time the phone connects it gets a new link.
// The data-channel protocol matches the browser computer role in
// src/companion-link.js, plus an "auth" message first (see verifyAuth).
type session struct {
	mu      sync.Mutex
	emit    func(map[string]any)
	api     *webrtc.API
	cert    webrtc.Certificate
	udp     net.PacketConn
	sniffer *sniffConn

	id     string
	secret []byte
	mid    string

	ident     *identity
	stateDir  string
	addresses []string

	phase  string
	closed bool
	paired bool // a phone has been verified with this identity
	seq    int  // message sequence, continuous across links
	cur    *link
	expiry *time.Timer
	done   chan struct{}
}

// pairingInfo describes a started session to the app.
type pairingInfo struct {
	Code, Link string
	Addresses  []string
	Expires    int64
	Paired     bool
	Note       string // why a saved pairing needs a new scan, if it does
}

// link is one peer connection with the phone.
type link struct {
	pc *webrtc.PeerConnection
	dc *webrtc.DataChannel

	dead, authed, verified, helloSeen, helloAck bool
	nonce                                       string
	pingSeq, pongSeq                            int
	lastPong                                    time.Time
	connectT, verifyT                           *time.Timer
	heartbeat                                   *time.Ticker
	stop                                        chan struct{}
}

// mustECDSAKey makes the DTLS key kept for the session's lifetime: the phone's
// stored code pins its fingerprint, so every reconnect presents the same one.
func mustECDSAKey() *ecdsa.PrivateKey {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return key
}

func interfaceAllowed(name string) bool {
	// macOS virtual interfaces, then Windows virtual adapters (Hyper-V/WSL, VPNs, VMs).
	for _, skip := range []string{"lo", "utun", "awdl", "llw", "bridge", "anpi", "ap", "gif", "stf", "vmnet", "vboxnet", "ipsec", "ppp",
		"vEthernet", "VMware", "VirtualBox", "Loopback", "Bluetooth", "Tailscale", "ZeroTier", "Hamachi", "OpenVPN", "WireGuard"} {
		if strings.HasPrefix(name, skip) {
			return false
		}
	}
	return true
}

// newSession listens for the phone that holds this identity's code.
func newSession(site string, emit func(map[string]any), ident *identity, stateDir string) (*session, *pairingInfo, error) {
	s := &session{emit: emit, id: ident.Session, secret: ident.secret, cert: ident.cert, ident: ident, stateDir: stateDir, done: make(chan struct{})}
	note := ""
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: ident.Port})
	if err != nil && ident.Port != 0 {
		note = "The network port this Mac used before is busy, so the phone needs to scan once more."
		udp, err = net.ListenUDP("udp4", &net.UDPAddr{})
	}
	if err != nil {
		return nil, nil, fmt.Errorf("could not open a network socket: %w", err)
	}
	ident.Port = udp.LocalAddr().(*net.UDPAddr).Port
	s.udp = udp
	s.sniffer = newSniffConn(udp, ident.Ufrag, ident.Pwd)

	se := webrtc.SettingEngine{}
	se.SetLite(true)
	se.SetICECredentials(ident.Ufrag, ident.Pwd)
	// The phone's certificate is checked by verifyAuth instead: the browser never
	// tells us its fingerprint, but it proves the QR secret over this exact channel.
	se.DisableCertificateFingerprintVerification(true)
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, s.sniffer))
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetInterfaceFilter(interfaceAllowed)
	se.SetIPFilter(func(ip net.IP) bool { return ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() })
	s.api = webrtc.NewAPI(webrtc.WithSettingEngine(se))

	first, sdp, err := s.newLink()
	if err != nil {
		udp.Close()
		return nil, nil, err
	}
	fingerprint, mid, cands, err := fromSDP(sdp)
	if err == nil && len(cands) == 0 {
		err = errors.New("this Mac has no local network address; connect to Wi-Fi or Ethernet")
	}
	if err != nil {
		first.pc.Close()
		udp.Close()
		return nil, nil, err
	}
	s.mid = mid
	for i, c := range cands {
		if i < maxCandidates {
			s.addresses = append(s.addresses, c.IP.String())
		}
	}
	// A saved pairing only works while the phone's code still points at this Mac.
	if ident.Paired && note == "" && !overlaps(s.addresses, ident.Addresses) {
		note = "This Mac's network address changed, so the phone needs to scan once more."
	}
	if note != "" {
		ident.Paired = false
	}
	s.paired = ident.Paired
	expires := time.Now().Add(pairingTTL).Truncate(time.Second).Add(time.Second)
	code, err := offerCode{Session: s.id, ExpiresMs: expires.UnixMilli(), Mid: mid, Ufrag: ident.Ufrag, Pwd: ident.Pwd, Fingerprint: fingerprint, Candidates: cands, Secret: s.secret}.encode()
	var link string
	if err == nil {
		link, err = pairingLink(site, code)
	}
	if err != nil {
		first.pc.Close()
		udp.Close()
		return nil, nil, err
	}
	s.mu.Lock()
	s.cur = first
	if !s.paired {
		s.expiry = time.AfterFunc(time.Until(expires), func() {
			s.mu.Lock()
			paired := s.paired
			s.mu.Unlock()
			if !paired {
				s.end("expired", "The pairing code expired. Create a new code and scan it again.")
			}
		})
	}
	s.mu.Unlock()
	go s.awaitPhone(first)
	if s.paired {
		s.state("waiting", "Waiting for your phone. Open Maple Atlas on the phone; it reconnects by itself.")
	} else {
		s.state("waiting", "Scan this code with your phone's camera. Both devices must use the same Wi-Fi.")
	}
	return s, &pairingInfo{Code: code, Link: link, Addresses: s.addresses, Expires: expires.UnixMilli(), Paired: s.paired, Note: note}, nil
}

func overlaps(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}

// newLink creates a peer connection that answers with the session's fixed
// credentials and certificate, so its offer matches the code already on the phone.
func (s *session) newLink() (*link, string, error) {
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{Certificates: []webrtc.Certificate{s.cert}})
	if err != nil {
		return nil, "", err
	}
	l := &link{pc: pc, stop: make(chan struct{})}
	ordered := true
	if l.dc, err = pc.CreateDataChannel(channelLabel, &webrtc.DataChannelInit{Ordered: &ordered}); err == nil {
		var offer webrtc.SessionDescription
		if offer, err = pc.CreateOffer(nil); err == nil {
			gathered := webrtc.GatheringCompletePromise(pc)
			if err = pc.SetLocalDescription(offer); err == nil {
				select {
				case <-gathered:
				case <-time.After(8 * time.Second):
					err = errors.New("could not find a local network address; check Wi-Fi")
				}
			}
		}
	}
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) { s.onConnectionState(l, state) })
	l.dc.OnOpen(func() { s.onOpen(l) })
	l.dc.OnClose(func() { s.lost(l, "channel", "The phone closed the connection.") })
	l.dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString && len(m.Data) <= 512 {
			s.onMessage(l, m.Data)
		}
	})
	return l, pc.LocalDescription().SDP, nil
}

// awaitPhone completes the handshake once a verified connectivity check reveals the
// phone's ICE username. The phone's ICE password and fingerprint are never needed:
// an ICE-lite agent only answers checks, and the certificate is verified by verifyAuth.
func (s *session) awaitPhone(l *link) {
	var remote string
	select {
	case remote = <-s.sniffer.found:
	case <-l.stop:
		return
	case <-s.done:
		return
	}
	// Usernames that queued while an older link was alive: the newest is the live phone.
	for drained := false; !drained; {
		select {
		case newer := <-s.sniffer.found:
			remote = newer
		default:
			drained = true
		}
	}
	s.mu.Lock()
	if s.closed || l.dead {
		s.mu.Unlock()
		return
	}
	resuming := s.paired
	l.connectT = time.AfterFunc(connectTimeout, func() {
		s.lost(l, "timeout", "Connection timed out. Keep Maple Atlas open on both devices on the same Wi-Fi network, then create a new code.")
	})
	s.mu.Unlock()
	if resuming {
		s.state("connecting", "The phone is back. Reconnecting…")
	} else {
		s.state("connecting", "Phone found. Connecting…")
	}
	zero := strings.TrimSuffix(strings.Repeat("00:", 32), ":")
	answer := strings.Join([]string{
		"v=0", "o=- 1 2 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE " + s.mid,
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
		"a=ice-ufrag:" + remote, "a=ice-pwd:" + randomICEString(24), "a=fingerprint:sha-256 " + zero,
		"a=setup:active", "a=mid:" + s.mid, "a=sctp-port:5000", "a=max-message-size:262144", "",
	}, "\r\n")
	if err := l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		s.lost(l, "setup", "The phone's connection could not be accepted: "+err.Error())
	}
}

func (s *session) onConnectionState(l *link, state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateFailed:
		s.lost(l, "network", "The phone could not reach this Mac. Use the same Wi-Fi network; guest Wi-Fi, VPNs or a firewall can block the link.")
	case webrtc.PeerConnectionStateDisconnected:
		s.mu.Lock()
		current := l == s.cur && l.verified && !s.closed
		if current {
			s.phase = "reconnecting"
		}
		s.mu.Unlock()
		if current {
			s.emit(map[string]any{"event": "state", "phase": "reconnecting", "message": "Connection interrupted. Waiting for the phone to respond…"})
		}
	}
}

func (s *session) onOpen(l *link) {
	s.mu.Lock()
	if s.closed || l.dead || l != s.cur {
		s.mu.Unlock()
		return
	}
	l.verifyT = time.AfterFunc(verifyTimeout, func() {
		s.lost(l, "verification", "Could not verify the phone. Reload Maple Atlas on the phone, then create a new code.")
	})
	s.mu.Unlock()
	s.state("verifying", "The link opened. Verifying the phone…")
}

// lost handles the end of a link. Before the first successful pairing it ends the
// session, as before. Afterwards the phone is only away (Android pauses pages in the
// background), so the session waits up to awayTTL for it and opens a new link.
func (s *session) lost(l *link, reason, msg string) {
	s.mu.Lock()
	if s.closed || l.dead || l != s.cur {
		s.mu.Unlock()
		return
	}
	paired := s.paired
	s.closeLinkLocked(l)
	if !paired {
		s.mu.Unlock()
		s.fail(reason, msg)
		return
	}
	s.cur = nil
	phase, text := "reconnecting", "Phone away. It reconnects by itself when you return to Maple Atlas on the phone."
	if reason == "bye" || reason == "user" {
		phase, text = "waiting", msg
	}
	s.phase = phase
	s.mu.Unlock()
	s.emit(map[string]any{"event": "state", "phase": phase, "reason": reason, "paired": true, "message": text})
	go s.replace()
}

// replace opens the next link for a returning phone.
func (s *session) replace() {
	next, _, err := s.newLink()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		if next != nil {
			next.pc.Close()
		}
		return
	}
	if err != nil {
		s.mu.Unlock()
		s.fail("setup", "Could not wait for the phone: "+err.Error())
		return
	}
	s.cur = next
	s.mu.Unlock()
	s.awaitPhone(next)
}

type message struct {
	Kind    string `json:"kind"`
	V       int    `json:"v"`
	Session string `json:"session"`
	Role    string `json:"role"`
	Nonce   string `json:"nonce"`
	Seq     int    `json:"seq"`
	Proof   string `json:"proof"`
}

func (s *session) onMessage(l *link, data []byte) {
	var m message
	if json.Unmarshal(data, &m) != nil {
		return
	}
	s.mu.Lock()
	if s.closed || l.dead || l != s.cur || m.Session != s.id {
		s.mu.Unlock()
		return
	}
	if !l.authed {
		s.mu.Unlock()
		if m.Kind != "auth" {
			return
		}
		if m.V != 3 || !s.verifyAuth(l, m.Proof) {
			s.lost(l, "verification", "This phone could not prove it scanned the code on this Mac. Create a new code and scan it again.")
			return
		}
		s.mu.Lock()
		l.authed = true
		l.nonce = randomHex(16)
		s.sendLocked(l, map[string]any{"kind": "hello", "v": 2, "session": s.id, "role": "pc", "nonce": l.nonce})
		s.mu.Unlock()
		return
	}
	switch {
	case m.Kind == "bye":
		s.mu.Unlock()
		s.lost(l, "bye", "Your phone disconnected. Tap Reconnect in Maple Atlas on the phone to continue.")
		return
	case (m.Kind == "hello" || m.Kind == "hello-ack" || m.Kind == "ping" || m.Kind == "pong") && m.V != 2:
		s.mu.Unlock()
		s.fail("version", "Maple Atlas on the phone uses a different pairing version. Reload it, then create a new code.")
		return
	case m.Kind == "hello" && m.Role == "phone" && len(m.Nonce) == 32:
		l.helloSeen = true
		s.sendLocked(l, map[string]any{"kind": "hello-ack", "v": 2, "session": s.id, "nonce": m.Nonce})
		s.confirmLocked(l)
	case m.Kind == "hello-ack" && l.nonce != "" && m.Nonce == l.nonce:
		l.helloAck = true
		s.confirmLocked(l)
	case m.Kind == "ping" && l.verified && m.Seq > 0:
		s.sendLocked(l, map[string]any{"kind": "pong", "v": 2, "session": s.id, "seq": m.Seq})
	case m.Kind == "pong" && l.verified && m.Seq > l.pongSeq && m.Seq <= l.pingSeq:
		l.pongSeq, l.lastPong = m.Seq, time.Now()
		if s.phase == "reconnecting" {
			s.phase = "connected"
			go s.emit(map[string]any{"event": "state", "phase": "connected", "message": "Connection restored. The phone is responding."})
		}
	}
	s.mu.Unlock()
}

// verifyAuth checks proof = HMAC-SHA256(secret, "maple-atlas-link|session|FP"),
// where FP is the certificate the phone actually used in this DTLS handshake.
// A device that relays the connection cannot produce it without the QR secret,
// and cannot reuse it because it is bound to the phone's own certificate.
func (s *session) verifyAuth(l *link, proof string) bool {
	der := l.pc.SCTP().Transport().GetRemoteCertificate()
	if len(der) == 0 {
		return false
	}
	sum := sha256.Sum256(der)
	fp := strings.ToUpper(hex.EncodeToString(sum[:]))
	var parts []string
	for i := 0; i < len(fp); i += 2 {
		parts = append(parts, fp[i:i+2])
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte("maple-atlas-link|" + s.id + "|" + strings.Join(parts, ":")))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(proof))
}

func (s *session) confirmLocked(l *link) {
	if !l.helloSeen || !l.helloAck || l.verified {
		return
	}
	resumed := s.paired
	l.verified, l.lastPong, s.paired = true, time.Now(), true
	for _, t := range []*time.Timer{s.expiry, l.connectT, l.verifyT} {
		if t != nil {
			t.Stop()
		}
	}
	if !s.ident.Paired {
		// Remember this phone: from now on it reconnects without scanning.
		s.ident.Paired, s.ident.Addresses = true, s.addresses
		if err := s.ident.save(s.stateDir); err != nil {
			go s.emit(map[string]any{"event": "log", "message": "Could not save the pairing: " + err.Error()})
		}
	}
	s.phase = "connected"
	msg := "Both devices exchanged a confirmation. The connection is working."
	if resumed {
		msg = "The phone is back. The connection is working."
	}
	go s.emit(map[string]any{"event": "state", "phase": "connected", "paired": true, "message": msg})
	l.heartbeat = time.NewTicker(pingEvery)
	go s.beat(l)
	s.pingLocked(l)
}

func (s *session) beat(l *link) {
	for {
		select {
		case <-l.heartbeat.C:
			s.mu.Lock()
			if l.dead {
				s.mu.Unlock()
				return
			}
			age := time.Since(l.lastPong)
			if age >= failAfter {
				s.mu.Unlock()
				s.lost(l, "heartbeat", "The phone stopped responding.")
				return
			}
			if age >= quietAfter && s.phase == "connected" {
				s.phase = "reconnecting"
				go s.emit(map[string]any{"event": "state", "phase": "reconnecting", "message": "No response from the phone. Checking the connection…"})
			}
			s.pingLocked(l)
			s.mu.Unlock()
		case <-l.stop:
			return
		}
	}
}

func (s *session) pingLocked(l *link) {
	l.pingSeq++
	s.sendLocked(l, map[string]any{"kind": "ping", "v": 2, "session": s.id, "seq": l.pingSeq})
}

func (s *session) sendLocked(l *link, v map[string]any) bool {
	if s.closed || l == nil || l.dead || l.dc == nil || l.dc.ReadyState() != webrtc.DataChannelStateOpen || l.dc.BufferedAmount() > 4096 {
		return false
	}
	b, _ := json.Marshal(v)
	return l.dc.SendText(string(b)) == nil
}

// sendSequenced sends a location, position or tracking message on the live link.
func (s *session) sendSequenced(v map[string]any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil || !s.cur.verified || s.phase != "connected" {
		return false
	}
	v["seq"] = s.seq
	ok := s.sendLocked(s.cur, v)
	if ok {
		s.seq++
	}
	return ok
}

// sendLocation, sendPosition and sendTracking mirror MapleCompanionLink.send/sendStatus.
func (s *session) sendLocation(id string, confidence int, observedAt int64) bool {
	if id == "" || confidence < 0 || confidence > 100 || observedAt <= 0 {
		return false
	}
	return s.sendSequenced(map[string]any{"kind": "location", "id": id, "confidence": confidence, "observedAt": observedAt})
}

// sendPosition reports the player's dot on the current map, in the portal data's
// coordinates. The phone accepts it only for the map it was last told about.
func (s *session) sendPosition(id string, x, y float64, observedAt int64) bool {
	if id == "" || observedAt <= 0 || math.IsNaN(x) || math.IsNaN(y) || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 {
		return false
	}
	return s.sendSequenced(map[string]any{"kind": "position", "id": id, "x": math.Round(x), "y": math.Round(y), "observedAt": observedAt})
}

func (s *session) sendTracking(state string) bool {
	if state != "searching" && state != "paused" {
		return false
	}
	return s.sendSequenced(map[string]any{"kind": "tracking", "state": state, "observedAt": time.Now().UnixMilli()})
}

func (s *session) state(phase, msg string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.phase = phase
	paired := s.paired
	s.mu.Unlock()
	s.emit(map[string]any{"event": "state", "phase": phase, "paired": paired, "message": msg})
}

// disconnect ends the current connection with a goodbye but keeps the pairing:
// the phone shows Reconnect, and the Mac keeps listening for it.
func (s *session) disconnect() {
	s.mu.Lock()
	l := s.cur
	if s.closed || l == nil || !l.verified || l.dead {
		s.mu.Unlock()
		return
	}
	b, _ := json.Marshal(map[string]any{"kind": "bye", "v": 2, "session": s.id})
	_ = l.dc.SendText(string(b))
	s.mu.Unlock()
	time.Sleep(200 * time.Millisecond)
	s.lost(l, "user", "Disconnected. Your phone can reconnect with one tap in Maple Atlas.")
}

func (s *session) fail(reason, msg string) {
	if s.close() {
		s.emit(map[string]any{"event": "state", "phase": "failed", "reason": reason, "message": msg})
	}
}

func (s *session) end(phase, msg string) {
	if s.close() {
		s.emit(map[string]any{"event": "state", "phase": phase, "message": msg})
	}
}

func (s *session) closeLinkLocked(l *link) {
	if l == nil || l.dead {
		return
	}
	l.dead = true
	for _, t := range []*time.Timer{l.connectT, l.verifyT} {
		if t != nil {
			t.Stop()
		}
	}
	if l.heartbeat != nil {
		l.heartbeat.Stop()
	}
	close(l.stop)
	go l.pc.Close()
}

// close releases everything once; it reports whether this call closed it.
func (s *session) close() bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	bye := false
	if l := s.cur; l != nil && l.verified && !l.dead && l.dc.ReadyState() == webrtc.DataChannelStateOpen {
		b, _ := json.Marshal(map[string]any{"kind": "bye", "v": 2, "session": s.id})
		bye = l.dc.SendText(string(b)) == nil
	}
	s.closed = true
	if s.expiry != nil {
		s.expiry.Stop()
	}
	close(s.done)
	l, udp := s.cur, s.udp
	var pc *webrtc.PeerConnection
	if l != nil && !l.dead {
		l.dead = true
		for _, t := range []*time.Timer{l.connectT, l.verifyT} {
			if t != nil {
				t.Stop()
			}
		}
		if l.heartbeat != nil {
			l.heartbeat.Stop()
		}
		close(l.stop)
		pc = l.pc
	}
	s.mu.Unlock()
	if bye {
		// Give the goodbye a moment to leave before the transport closes.
		time.Sleep(200 * time.Millisecond)
	}
	if pc != nil {
		pc.Close()
	}
	if udp != nil {
		udp.Close()
	}
	return true
}
