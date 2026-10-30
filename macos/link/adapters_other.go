//go:build !windows

package main

import "net"

// realAdapterIPs: the IPv4 addresses of adapters that are up and not virtual.
func realAdapterIPs() map[string]bool {
	out := map[string]bool{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || !interfaceAllowed(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				out[ipn.IP.To4().String()] = true
			}
		}
	}
	return out
}
