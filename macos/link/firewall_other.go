//go:build desktopui && !windows

package main

import "errors"

type firewallReport struct {
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// Only Windows needs a firewall exception for the phone (development builds elsewhere).
func firewallStatus() firewallReport { return firewallReport{State: "ok"} }

func fixFirewall() error { return errors.New("not needed on this system") }
