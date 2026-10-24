package main

import (
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

// session is one pairing attempt and, once verified, one live phone link.
// It speaks the same data-channel protocol as the browser computer role in
// src/companion-link.js, plus an "auth" message first (see verifyAuth).
type session struct {
	mu   sync.Mutex
	emit func(map[string]any)

	pc   *webrtc.PeerConnection
	dc   *webrtc.DataChannel
	conn net.PacketConn

	id     string
	secret []byte
	nonce  string

	phase                     string
	closed, authed, verified  bool
	helloSeen, helloAck       bool
	seq, pingSeq, pongSeq     int
	lastPong                  time.Time
	expiry, connectT, verifyT *time.Timer
	heartbeat                 *time.Ticker
	stopHeartbeat             chan struct{}
}

func interfaceAllowed(name string) bool {
	for _, skip := range []string{"lo", "utun", "awdl", "llw", "bridge", "anpi", "ap", "gif", "stf", "vmnet", "vboxnet", "ipsec", "ppp"} {
		if strings.HasPrefix(name, skip) {
			return false
		}
	}
	return true
}

// newSession opens a socket, gathers host candidates and returns the pairing code.
func newSession(site string, emit func(map[string]any)) (*session, string, string, []string, int64, error) {
	s := &session{emit: emit, id: randomHex(8), secret: make([]byte, 16), stopHeartbeat: make(chan struct{})}
	if _, err := rand.Read(s.secret); err != nil {
		return nil, "", "", nil, 0, err
	}
	ufrag, pwd := randomICEString(16), randomICEString(32)
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return nil, "", "", nil, 0, fmt.Errorf("could not open a network socket: %w", err)
	}
	sniffer := newSniffConn(udp, ufrag, pwd)
	s.conn = udp

	se := webrtc.SettingEngine{}
	se.SetLite(true)
	se.SetICECredentials(ufrag, pwd)
	// The phone's certificate is checked by verifyAuth instead: the browser never
	// tells us its fingerprint, but it proves the QR secret over this exact channel.
	se.DisableCertificateFingerprintVerification(true)
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, sniffer))
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetInterfaceFilter(interfaceAllowed)
	se.SetIPFilter(func(ip net.IP) bool { return ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() })
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		udp.Close()
		return nil, "", "", nil, 0, err
	}
	s.pc = pc
	ordered := true
	dc, err := pc.CreateDataChannel(channelLabel, &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	s.dc = dc
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	select {
	case <-gathered:
	case <-time.After(8 * time.Second):
		s.close()
		return nil, "", "", nil, 0, errors.New("could not find a local network address; check Wi-Fi")
	}
	fingerprint, mid, cands, err := fromSDP(pc.LocalDescription().SDP)
	if err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	if len(cands) == 0 {
		s.close()
		return nil, "", "", nil, 0, errors.New("this Mac has no local network address; connect to Wi-Fi or Ethernet")
	}
	expires := time.Now().Add(pairingTTL).Truncate(time.Second).Add(time.Second)
	code, err := offerCode{Session: s.id, ExpiresMs: expires.UnixMilli(), Mid: mid, Ufrag: ufrag, Pwd: pwd, Fingerprint: fingerprint, Candidates: cands, Secret: s.secret}.encode()
	if err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	link, err := pairingLink(site, code)
	if err != nil {
		s.close()
		return nil, "", "", nil, 0, err
	}
	var addresses []string
	for i, c := range cands {
		if i < maxCandidates {
			addresses = append(addresses, c.IP.String())
		}
	}

	pc.OnConnectionStateChange(s.onConnectionState)
	dc.OnOpen(s.onOpen)
	dc.OnClose(func() {
		s.end("disconnected", "The phone disconnected or closed Maple Atlas. Create a new code to reconnect.")
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString && len(m.Data) <= 512 {
			s.onMessage(m.Data)
		}
	})
	s.mu.Lock()
	s.expiry = time.AfterFunc(time.Until(expires), func() {
		s.mu.Lock()
		verified := s.verified
		s.mu.Unlock()
		if !verified {
			s.end("expired", "The pairing code expired. Create a new code and scan it again.")
		}
	})
	s.mu.Unlock()
	go s.awaitPhone(sniffer, mid)
	s.state("waiting", "Scan this code with your phone's camera. Both devices must use the same Wi-Fi.")
	return s, code, link, addresses, expires.UnixMilli(), nil
}

// awaitPhone completes the WebRTC handshake once the phone's first verified
// connectivity check reveals its ICE username.
func (s *session) awaitPhone(sniffer *sniffConn, mid string) {
	var remote string
	select {
	case remote = <-sniffer.found:
	case <-s.stopHeartbeat:
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.connectT = time.AfterFunc(connectTimeout, func() {
		s.fail("timeout", "Connection timed out. Keep Maple Atlas open on both devices on the same Wi-Fi network, then create a new code.")
	})
	s.mu.Unlock()
	s.state("connecting", "Phone found. Connecting…")
	// The phone's real ICE password and fingerprint are never needed: an ICE-lite
	// agent only answers checks, and the certificate is verified by verifyAuth.
	zero := strings.TrimSuffix(strings.Repeat("00:", 32), ":")
	answer := strings.Join([]string{
		"v=0", "o=- 1 2 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE " + mid,
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
		"a=ice-ufrag:" + remote, "a=ice-pwd:" + randomICEString(24), "a=fingerprint:sha-256 " + zero,
		"a=setup:active", "a=mid:" + mid, "a=sctp-port:5000", "a=max-message-size:262144", "",
	}, "\r\n")
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		s.fail("setup", "The phone's connection could not be accepted: "+err.Error())
	}
}

func (s *session) onConnectionState(state webrtc.PeerConnectionState) {
	s.mu.Lock()
	verified := s.verified
	s.mu.Unlock()
	switch state {
	case webrtc.PeerConnectionStateFailed:
		s.fail("network", "The phone could not reach this Mac. Use the same Wi-Fi network; guest Wi-Fi, VPNs or a firewall can block the link.")
	case webrtc.PeerConnectionStateDisconnected:
		if verified {
			s.state("reconnecting", "Connection interrupted. Waiting for the phone to respond…")
		}
	}
}

func (s *session) onOpen() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.verifyT = time.AfterFunc(verifyTimeout, func() {
		s.fail("verification", "Could not verify the phone. Reload Maple Atlas on the phone, then create a new code.")
	})
	s.mu.Unlock()
	s.state("verifying", "The link opened. Verifying the phone…")
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

func (s *session) onMessage(data []byte) {
	var m message
	if json.Unmarshal(data, &m) != nil {
		return
	}
	s.mu.Lock()
	if s.closed || m.Session != s.id {
		s.mu.Unlock()
		return
	}
	if !s.authed {
		s.mu.Unlock()
		if m.Kind != "auth" {
			return
		}
		if m.V != 3 || !s.verifyAuth(m.Proof) {
			s.fail("verification", "This phone could not prove it scanned the code on this Mac. Create a new code and scan it again.")
			return
		}
		s.mu.Lock()
		s.authed = true
		s.nonce = randomHex(16)
		nonce := s.nonce
		s.mu.Unlock()
		s.send(map[string]any{"kind": "hello", "v": 2, "session": s.id, "role": "pc", "nonce": nonce})
		return
	}
	defer s.mu.Unlock()
	switch {
	case (m.Kind == "hello" || m.Kind == "hello-ack" || m.Kind == "ping" || m.Kind == "pong") && m.V != 2:
		go s.fail("version", "Maple Atlas on the phone uses a different pairing version. Reload it, then create a new code.")
	case m.Kind == "hello" && m.Role == "phone" && len(m.Nonce) == 32:
		s.helloSeen = true
		s.sendLocked(map[string]any{"kind": "hello-ack", "v": 2, "session": s.id, "nonce": m.Nonce})
		s.confirmLocked()
	case m.Kind == "hello-ack" && s.nonce != "" && m.Nonce == s.nonce:
		s.helloAck = true
		s.confirmLocked()
	case m.Kind == "ping" && s.verified && m.Seq > 0:
		s.sendLocked(map[string]any{"kind": "pong", "v": 2, "session": s.id, "seq": m.Seq})
	case m.Kind == "pong" && s.verified && m.Seq > s.pongSeq && m.Seq <= s.pingSeq:
		s.pongSeq, s.lastPong = m.Seq, time.Now()
		if s.phase == "reconnecting" {
			s.phase = "connected"
			go s.emit(map[string]any{"event": "state", "phase": "connected", "message": "Connection restored. The phone is responding."})
		}
	}
}

// verifyAuth checks proof = HMAC-SHA256(secret, "maple-atlas-link|session|FP"),
// where FP is the certificate the phone actually used in this DTLS handshake.
// A device that relays the connection cannot produce it without the QR secret,
// and cannot reuse it because it is bound to the phone's own certificate.
func (s *session) verifyAuth(proof string) bool {
	der := s.pc.SCTP().Transport().GetRemoteCertificate()
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

func (s *session) confirmLocked() {
	if !s.helloSeen || !s.helloAck || s.verified {
		return
	}
	s.verified, s.lastPong = true, time.Now()
	for _, t := range []*time.Timer{s.expiry, s.connectT, s.verifyT} {
		if t != nil {
			t.Stop()
		}
	}
	s.phase = "connected"
	go s.emit(map[string]any{"event": "state", "phase": "connected", "message": "Both devices exchanged a confirmation. The connection is working."})
	s.heartbeat = time.NewTicker(pingEvery)
	go s.beat(s.heartbeat)
	s.pingLocked()
}

func (s *session) beat(t *time.Ticker) {
	for {
		select {
		case <-t.C:
			s.mu.Lock()
			age := time.Since(s.lastPong)
			if age >= failAfter {
				s.mu.Unlock()
				s.fail("heartbeat", "The phone stopped responding. Keep Maple Atlas open on the phone, then create a new code.")
				return
			}
			if age >= quietAfter && s.phase == "connected" {
				s.phase = "reconnecting"
				go s.emit(map[string]any{"event": "state", "phase": "reconnecting", "message": "No response from the phone. Checking the connection…"})
			}
			s.pingLocked()
			s.mu.Unlock()
		case <-s.stopHeartbeat:
			return
		}
	}
}

func (s *session) pingLocked() {
	s.pingSeq++
	s.sendLocked(map[string]any{"kind": "ping", "v": 2, "session": s.id, "seq": s.pingSeq})
}

func (s *session) send(v map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sendLocked(v)
}

func (s *session) sendLocked(v map[string]any) bool {
	if s.closed || s.dc == nil || s.dc.ReadyState() != webrtc.DataChannelStateOpen || s.dc.BufferedAmount() > 4096 {
		return false
	}
	b, _ := json.Marshal(v)
	return s.dc.SendText(string(b)) == nil
}

// sendLocation and sendTracking mirror MapleCompanionLink.send/sendStatus.
func (s *session) sendLocation(id string, confidence int, observedAt int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.verified || s.phase != "connected" || id == "" || confidence < 0 || confidence > 100 || observedAt <= 0 {
		return false
	}
	ok := s.sendLocked(map[string]any{"kind": "location", "id": id, "confidence": confidence, "observedAt": observedAt, "seq": s.seq})
	if ok {
		s.seq++
	}
	return ok
}

// sendPosition reports the player's dot on the current map, in the portal data's
// coordinates. The phone accepts it only for the map it was last told about.
func (s *session) sendPosition(id string, x, y float64, observedAt int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.verified || s.phase != "connected" || id == "" || observedAt <= 0 || math.IsNaN(x) || math.IsNaN(y) ||
		math.Abs(x) > 1e6 || math.Abs(y) > 1e6 {
		return false
	}
	ok := s.sendLocked(map[string]any{"kind": "position", "id": id, "x": math.Round(x), "y": math.Round(y), "observedAt": observedAt, "seq": s.seq})
	if ok {
		s.seq++
	}
	return ok
}

func (s *session) sendTracking(state string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.verified || s.phase != "connected" || (state != "searching" && state != "paused") {
		return false
	}
	ok := s.sendLocked(map[string]any{"kind": "tracking", "state": state, "seq": s.seq, "observedAt": time.Now().UnixMilli()})
	if ok {
		s.seq++
	}
	return ok
}

func (s *session) state(phase, msg string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.phase = phase
	s.mu.Unlock()
	s.emit(map[string]any{"event": "state", "phase": phase, "message": msg})
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

// close releases everything once; it reports whether this call closed it.
func (s *session) close() bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	s.closed = true
	for _, t := range []*time.Timer{s.expiry, s.connectT, s.verifyT} {
		if t != nil {
			t.Stop()
		}
	}
	if s.heartbeat != nil {
		s.heartbeat.Stop()
	}
	close(s.stopHeartbeat)
	pc, conn, dc := s.pc, s.conn, s.dc
	bye := false
	if s.verified && dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		b, _ := json.Marshal(map[string]any{"kind": "bye", "v": 2, "session": s.id})
		bye = dc.SendText(string(b)) == nil
	}
	s.mu.Unlock()
	if bye {
		// Give the goodbye a moment to leave before the transport closes.
		time.Sleep(200 * time.Millisecond)
	}
	if pc != nil {
		pc.Close()
	}
	if conn != nil {
		conn.Close()
	}
	return true
}
