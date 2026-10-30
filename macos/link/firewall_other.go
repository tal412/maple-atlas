//go:build desktopui && !windows

package main

// Only Windows needs a firewall exception for the phone (development builds elsewhere).
func firewallStatus() firewallReport { return firewallReport{State: "ok"} }

func fixFirewall(string) firewallRepair { return firewallRepair{Error: "not needed on this system"} }
