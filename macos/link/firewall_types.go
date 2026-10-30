//go:build desktopui

package main

// What the window shows about Windows Firewall, and what the repair button did.
type firewallReport struct {
	State    string   `json:"state"` // ok, blocked, missing, shielded, unknown
	Detail   string   `json:"detail,omitempty"`
	Profiles []string `json:"profiles,omitempty"` // active network types with the firewall on
	Rules    []string `json:"rules,omitempty"`    // this program's inbound rules, readable
	// Why a rule might not help: group policy overriding local rules, or all inbound blocked.
	Policy string `json:"policy,omitempty"`
	// Other firewall products registered with Windows Security (they filter instead of, or
	// as well as, Windows Firewall).
	Others []string `json:"others,omitempty"`
	// Every inbound rule that mentions the app by name or path, as Windows stores it (the raw
	// program path shows a rule made for another copy of the app).
	Related []string `json:"related,omitempty"`
	Exe     string   `json:"exe,omitempty"`
	// Whether Windows accepts replies to the app's multicast heartbeat (the way in that
	// needs no rule), per active network type.
	Heartbeat string `json:"heartbeat,omitempty"`
}

type firewallRepair struct {
	Approved bool   `json:"approved"` // Windows' approval prompt was accepted
	Finished bool   `json:"finished"` // the repair ran to the end
	Exit     int    `json:"exit"`
	Error    string `json:"error,omitempty"`
	Method   string `json:"method,omitempty"` // com, netsh
	Output   string `json:"output,omitempty"` // netsh's words when it was used
}
