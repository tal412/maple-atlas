//go:build desktopui

package main

// What the window shows about Windows Firewall, and what the repair button did.
type firewallReport struct {
	State    string   `json:"state"` // ok, blocked, missing, shielded, unknown
	Detail   string   `json:"detail,omitempty"`
	Profiles []string `json:"profiles,omitempty"` // active network types with the firewall on
	Rules    []string `json:"rules,omitempty"`    // this program's inbound rules, readable
}

type firewallRepair struct {
	Approved bool   `json:"approved"` // Windows' approval prompt was accepted
	Finished bool   `json:"finished"` // the repair ran to the end
	Exit     int    `json:"exit"`
	Error    string `json:"error,omitempty"`
}
