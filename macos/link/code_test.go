package main

import (
	"net"
	"strings"
	"testing"
)

// golden is produced by pack() in src/companion-link.js for the same inputs; the
// JS tests check the same string, so both encoders must stay byte-compatible.
const golden = "MA2FCVKVKVKVKVKVKTLJHJAAAJQARAWEQZRDBQWEY3EMVTGO2DJNJVWY3LON5YHC4TTOR2XMMJSAADQ4FI4EMVDCOB7IZGVIW3CNFYHO7UFRSJZVINIV63L3RGL2LMQCBAKAAAAEMBZAAAQEAYEAUDAOCAJBIFQYDIOB4"

func TestOfferCodeMatchesJavaScript(t *testing.T) {
	fp := make([]byte, 32)
	secret := make([]byte, 16)
	for i := range fp {
		fp[i] = byte(i * 7)
	}
	for i := range secret {
		secret[i] = byte(i)
	}
	code, err := offerCode{Session: strings.Repeat("a", 16), ExpiresMs: 1800000000000, Mid: "0", Ufrag: "AbC1", Pwd: "abcdefghijklmnopqrstuv12",
		Fingerprint: fp, Candidates: []hostCandidate{{IP: net.ParseIP("10.0.0.2"), Port: 12345}}, Secret: secret}.encode()
	if err != nil || code != golden {
		t.Fatalf("code %q, err %v; want %q", code, err, golden)
	}
}

func TestFromSDPPrefersPrivateIPv4(t *testing.T) {
	sdp := "a=fingerprint:sha-256 " + strings.TrimSuffix(strings.Repeat("AB:", 32), ":") + "\r\na=mid:0\r\n" +
		"a=candidate:1 1 udp 1 203.0.113.5 1000 typ host\r\na=candidate:2 1 udp 1 192.168.1.4 2000 typ host\r\n" +
		"a=candidate:3 1 tcp 1 192.168.1.4 9 typ host tcptype passive\r\na=candidate:4 1 udp 1 192.168.1.4 2000 typ host\r\n"
	fp, mid, cands, err := fromSDP(sdp)
	if err != nil || len(fp) != 32 || mid != "0" || len(cands) != 2 || cands[0].IP.String() != "192.168.1.4" {
		t.Fatalf("fp %d mid %q cands %v err %v", len(fp), mid, cands, err)
	}
}

func TestPairingLinkKeepsCodeInFragment(t *testing.T) {
	link, err := pairingLink("https://tal412.github.io/maple-atlas/dev?x=1#old", "MA2ABC")
	if err != nil || link != "https://tal412.github.io/maple-atlas/dev/#link=MA2ABC" {
		t.Fatalf("link %q err %v", link, err)
	}
	if _, err := pairingLink("ftp://example.com/", "MA2ABC"); err == nil {
		t.Fatal("non-web site accepted")
	}
}
