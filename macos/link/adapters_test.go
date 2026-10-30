package main

import (
	"net"
	"testing"
)

func TestOnRealAdapters(t *testing.T) {
	c := func(ip string) hostCandidate { return hostCandidate{IP: net.ParseIP(ip)} }
	// As seen on a Windows PC: the Hyper-V NAT address came first in the code.
	all := []hostCandidate{c("192.168.128.1"), c("172.20.0.1"), c("10.1.0.38")}
	got := onRealAdapters(all, map[string]bool{"10.1.0.38": true})
	if len(got) != 1 || got[0].IP.String() != "10.1.0.38" {
		t.Fatalf("kept %v", got)
	}
	if got := onRealAdapters(all, map[string]bool{}); len(got) != 3 {
		t.Fatalf("with no real adapter every address must stay, got %v", got)
	}
	if !interfaceAllowed("Wi-Fi") || !interfaceAllowed("Ethernet 4") || interfaceAllowed("vEthernet (nat)") || interfaceAllowed("vEthernet (WSL)") {
		t.Fatal("adapter names misjudged")
	}
}
