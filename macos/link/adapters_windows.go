//go:build windows

package main

import (
	"net"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// realAdapterIPs: IPv4 addresses of adapters that are up, have a default gateway (the home
// network has one; Hyper-V/WSL NAT and VirtualBox host-only adapters do not) and are not a
// VPN or virtual adapter by their description. Falls back to the name check when Windows
// gives no adapter list.
func realAdapterIPs() map[string]bool {
	out := map[string]bool{}
	size := uint32(16 << 10)
	var buf []byte
	for i := 0; i < 3; i++ {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_INET, windows.GAA_FLAG_INCLUDE_GATEWAYS|windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST|windows.GAA_FLAG_SKIP_DNS_SERVER,
			0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if err != windows.ERROR_BUFFER_OVERFLOW {
			return namedAdapterIPs()
		}
	}
	virtual := []string{"hyper-v", "virtual", "vmware", "virtualbox", "tap-", "tap ", "wintun", "wireguard", "openvpn", "vpn", "npcap", "loopback",
		"tailscale", "zerotier", "hamachi", "radmin", "nordlynx", "bluetooth", "wsl"}
	for a := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); a != nil; a = a.Next {
		if a.OperStatus != windows.IfOperStatusUp || a.FirstGatewayAddress == nil {
			continue
		}
		desc := strings.ToLower(windows.UTF16PtrToString(a.Description) + " " + windows.UTF16PtrToString(a.FriendlyName))
		skip := false
		for _, v := range virtual {
			skip = skip || strings.Contains(desc, v)
		}
		if skip {
			continue
		}
		for u := a.FirstUnicastAddress; u != nil; u = u.Next {
			if ip := u.Address.IP(); ip != nil && ip.To4() != nil {
				out[ip.To4().String()] = true
			}
		}
	}
	if len(out) == 0 {
		return namedAdapterIPs()
	}
	return out
}

// namedAdapterIPs: addresses of adapters that are up and not virtual by name.
func namedAdapterIPs() map[string]bool {
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
