package main

// MA2 pairing codes. This must stay byte-for-byte compatible with pack/unpack in
// src/companion-link.js. A native host sets header bit 3 (ICE-lite, single scan)
// and appends a 16-byte secret the phone uses to prove it scanned this screen.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	codePrefix    = "MA2"
	maxCandidates = 4
	base32Chars   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
)

type hostCandidate struct {
	IP   net.IP
	Port int
}

type offerCode struct {
	Session     string // 16 hex chars
	ExpiresMs   int64  // multiple of 1000
	Mid         string
	Ufrag, Pwd  string
	Fingerprint []byte // SHA-256, 32 bytes
	Candidates  []hostCandidate
	Secret      []byte // 16 bytes
}

func base32(data []byte) string {
	var out strings.Builder
	value, bits := 0, 0
	for _, b := range data {
		value = (value<<8 | int(b)) & 0xffff
		bits += 8
		for bits >= 5 {
			out.WriteByte(base32Chars[(value>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		out.WriteByte(base32Chars[(value<<(5-bits))&31])
	}
	return out.String()
}

func (c offerCode) encode() (string, error) {
	if len(c.Fingerprint) != 32 || len(c.Secret) != 16 || c.ExpiresMs%1000 != 0 {
		return "", errors.New("invalid pairing parameters")
	}
	session, err := hex.DecodeString(c.Session)
	if err != nil || len(session) != 8 {
		return "", errors.New("invalid session")
	}
	// Header: version 2, offer, setup actpass (0), native host flag.
	out := []byte{0x20 | 0x08}
	out = append(out, session...)
	seconds := uint32(c.ExpiresMs / 1000)
	out = append(out, byte(seconds>>24), byte(seconds>>16), byte(seconds>>8), byte(seconds))
	for _, s := range []string{c.Mid, c.Ufrag, c.Pwd} {
		out = append(out, byte(len(s)))
		out = append(out, s...)
	}
	out = append(out, c.Fingerprint...)
	cands := c.Candidates
	if len(cands) > maxCandidates {
		cands = cands[:maxCandidates]
	}
	if len(cands) == 0 {
		return "", errors.New("no local network address")
	}
	out = append(out, byte(len(cands)))
	for _, cand := range cands {
		if v4 := cand.IP.To4(); v4 != nil {
			out = append(out, 4)
			out = append(out, v4...)
		} else {
			out = append(out, 6)
			out = append(out, cand.IP.To16()...)
		}
		out = append(out, byte(cand.Port>>8), byte(cand.Port))
	}
	out = append(out, c.Secret...)
	return codePrefix + base32(out), nil
}

var (
	fingerprintLine = regexp.MustCompile(`(?m)^a=fingerprint:sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})\s*$`)
	midLine         = regexp.MustCompile(`(?m)^a=mid:(\S+)`)
)

// fromSDP reads the fingerprint, mid and UDP host candidates from a local offer.
func fromSDP(sdp string) (fingerprint []byte, mid string, cands []hostCandidate, err error) {
	m := fingerprintLine.FindStringSubmatch(sdp)
	if m == nil {
		return nil, "", nil, errors.New("offer has no SHA-256 fingerprint")
	}
	fingerprint, _ = hex.DecodeString(strings.ReplaceAll(m[1], ":", ""))
	mid = "0"
	if mm := midLine.FindStringSubmatch(sdp); mm != nil {
		mid = mm[1]
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		p := strings.Fields(line)
		if len(p) < 8 || p[1] != "1" || !strings.EqualFold(p[2], "udp") || p[6] != "typ" || p[7] != "host" {
			continue
		}
		ip := net.ParseIP(p[4])
		port, perr := strconv.Atoi(p[5])
		if ip == nil || perr != nil || port < 1 || port > 65535 || seen[p[4]+":"+p[5]] {
			continue
		}
		seen[p[4]+":"+p[5]] = true
		cands = append(cands, hostCandidate{IP: ip, Port: port})
	}
	// Private IPv4 first: that is the address a phone on the same Wi-Fi reaches.
	sort.SliceStable(cands, func(i, j int) bool { return rank(cands[i].IP) < rank(cands[j].IP) })
	return fingerprint, mid, cands, nil
}

func rank(ip net.IP) int {
	switch {
	case ip.To4() != nil && ip.IsPrivate():
		return 0
	case ip.To4() != nil:
		return 1
	default:
		return 2
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func randomICEString(n int) string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}

// pairingLink is the URL in the QR: the phone's camera opens the site, and the
// code stays in the fragment, which browsers never send to the server.
func pairingLink(site, code string) (string, error) {
	u, err := url.Parse(site)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("invalid site URL %q", site)
	}
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	u.RawQuery, u.Fragment = "", ""
	return u.String() + "#link=" + code, nil
}
