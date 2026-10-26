//go:build desktopui && windows

package main

// Windows Firewall drops the phone's connection unless this program is allowed for
// inbound traffic on the current network. The setup program adds that permission
// while it installs (it already runs as administrator), by running this program
// with --repair-firewall. The window checks it at launch through the Windows
// Firewall API; if something later removed or blocked it (for example a "Cancel"
// on the firewall's own prompt), one button runs the same repair, and Windows asks
// for approval naming Maple Atlas Companion. No scripts or shells are involved.

import (
	"encoding/json"
	"errors"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

type firewallReport struct {
	State  string `json:"state"` // ok, blocked, missing, shielded, unknown
	Detail string `json:"detail,omitempty"`
}

const (
	fwDomain  = 1
	fwPrivate = 2
	fwPublic  = 4
	fwAll     = 0x7fffffff
	fwIn      = 1
	fwBlock   = 0
	fwAllow   = 1
	protoTCP  = 6
	protoUDP  = 17
	protoAny  = 256
	ruleName  = "Maple Atlas Companion"
)

var profileNames = map[int]string{fwDomain: "domain", fwPrivate: "private", fwPublic: "public"}

func init() {
	firewallCommand = func(arg string) int {
		var err error
		switch arg {
		case "--repair-firewall":
			err = withFirewall(allowSelf)
		case "--remove-firewall":
			err = withFirewall(removeSelf)
		case "--check-firewall": // diagnostics: prints what the window would report
			b, _ := json.Marshal(firewallStatus())
			os.Stdout.Write(append(b, '\n'))
			return 0
		default:
			return 2
		}
		if err != nil {
			return 1
		}
		return 0
	}
}

// withFirewall runs fn with the HNetCfg.FwPolicy2 object on a COM-initialized thread.
func withFirewall(fn func(policy *ole.IDispatch) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		if oe, ok := err.(*ole.OleError); !ok || oe.Code() != 1 { // S_FALSE: already initialized
			return err
		}
	}
	defer ole.CoUninitialize()
	unknown, err := oleutil.CreateObject("HNetCfg.FwPolicy2")
	if err != nil {
		return err
	}
	defer unknown.Release()
	policy, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return err
	}
	defer policy.Release()
	return fn(policy)
}

type fwRule struct {
	name                               string
	direction, action, profiles, proto int
	enabled                            bool
}

func intOf(v *ole.VARIANT) int {
	if v == nil {
		return 0
	}
	switch x := v.Value().(type) {
	case int32:
		return int(x)
	case int64:
		return int(x)
	case int16:
		return int(x)
	case uint32:
		return int(x)
	case int:
		return x
	}
	return 0
}

func prop(d *ole.IDispatch, name string, params ...any) *ole.VARIANT {
	v, err := oleutil.GetProperty(d, name, params...)
	if err != nil {
		return nil
	}
	return v
}

// expandWindowsVars expands %NAME% the way Windows stores paths in firewall rules.
func expandWindowsVars(s string) string {
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '%')
		if i < 0 {
			b.WriteString(s)
			return b.String()
		}
		j := strings.IndexByte(s[i+1:], '%')
		if j < 0 {
			b.WriteString(s)
			return b.String()
		}
		b.WriteString(s[:i] + os.Getenv(s[i+1:i+1+j]))
		s = s[i+2+j:]
	}
}

// ownRules lists the inbound rules that name this program, however Windows stored
// the path (letter case, %ProgramFiles%).
func ownRules(policy *ole.IDispatch, exe string) ([]fwRule, error) {
	rulesV, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		return nil, err
	}
	rules := rulesV.ToIDispatch()
	defer rules.Release()
	var out []fwRule
	err = oleutil.ForEach(rules, func(v *ole.VARIANT) error {
		d := v.ToIDispatch()
		if d == nil {
			return nil
		}
		defer d.Release()
		app := ""
		if a := prop(d, "ApplicationName"); a != nil {
			app = a.ToString()
		}
		if app == "" || !strings.EqualFold(expandWindowsVars(app), exe) {
			return nil
		}
		r := fwRule{direction: intOf(prop(d, "Direction")), action: intOf(prop(d, "Action")),
			profiles: intOf(prop(d, "Profiles")), proto: intOf(prop(d, "Protocol"))}
		if n := prop(d, "Name"); n != nil {
			r.name = n.ToString()
		}
		if e := prop(d, "Enabled"); e != nil {
			r.enabled, _ = e.Value().(bool)
		}
		if r.direction == fwIn {
			out = append(out, r)
		}
		return nil
	})
	return out, err
}

func firewallStatus() firewallReport {
	exe, err := os.Executable()
	if err != nil {
		return firewallReport{State: "unknown"}
	}
	var report firewallReport
	err = withFirewall(func(policy *ole.IDispatch) error {
		current := intOf(prop(policy, "CurrentProfileTypes"))
		var active []int
		shielded := ""
		for _, p := range []int{fwDomain, fwPrivate, fwPublic} {
			if current&p == 0 {
				continue
			}
			if on := prop(policy, "FirewallEnabled", p); on == nil || on.Value() != true {
				continue
			}
			active = append(active, p)
			if all := prop(policy, "BlockAllInboundTraffic", p); all != nil && all.Value() == true {
				shielded = profileNames[p]
			}
		}
		if len(active) == 0 {
			report = firewallReport{State: "ok"}
			return nil
		}
		if shielded != "" {
			report = firewallReport{State: "shielded", Detail: "Windows Firewall is set to block all incoming connections on this " + shielded + " network. In Windows Security > Firewall & network protection, open that network and turn off \"Block all incoming connections\"."}
			return nil
		}
		rules, err := ownRules(policy, exe)
		if err != nil {
			return err
		}
		udp := func(r fwRule) bool { return r.enabled && (r.proto == protoUDP || r.proto == protoAny || r.proto == 0) }
		missing := ""
		for _, p := range active {
			blocked, allowed := false, false
			for _, r := range rules {
				if udp(r) && r.profiles&p != 0 {
					blocked = blocked || r.action == fwBlock
					allowed = allowed || r.action == fwAllow
				}
			}
			if blocked {
				report = firewallReport{State: "blocked", Detail: "Windows Firewall is set to block Maple Atlas Companion."}
				return nil
			}
			if !allowed && missing == "" {
				missing = profileNames[p]
			}
		}
		if missing != "" {
			report = firewallReport{State: "missing", Detail: "Maple Atlas Companion is not allowed on this " + missing + " network yet."}
		} else {
			report = firewallReport{State: "ok"}
		}
		return nil
	})
	if err != nil {
		return firewallReport{State: "unknown"}
	}
	return report
}

// removeSelf deletes every inbound rule for this program, including "block" rules
// Windows saved when its prompt was cancelled.
func removeSelf(policy *ole.IDispatch) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	rulesV, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		return err
	}
	rules := rulesV.ToIDispatch()
	defer rules.Release()
	for i := 0; i < 50; i++ {
		own, err := ownRules(policy, exe)
		if err != nil {
			return err
		}
		if len(own) == 0 {
			return nil
		}
		if _, err := oleutil.CallMethod(rules, "Remove", own[0].name); err != nil {
			return err
		}
	}
	return errors.New("could not remove the old firewall rules")
}

// allowSelf replaces this program's inbound rules with "allow" (UDP and TCP) on
// every network type.
func allowSelf(policy *ole.IDispatch) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := removeSelf(policy); err != nil {
		return err
	}
	rulesV, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		return err
	}
	rules := rulesV.ToIDispatch()
	defer rules.Release()
	for _, proto := range []int{protoUDP, protoTCP} {
		unknown, err := oleutil.CreateObject("HNetCfg.FWRule")
		if err != nil {
			return err
		}
		rule, err := unknown.QueryInterface(ole.IID_IDispatch)
		unknown.Release()
		if err != nil {
			return err
		}
		// Protocol must be set before ports or profiles, as the API requires.
		for _, kv := range []struct {
			k string
			v any
		}{{"Name", ruleName}, {"Description", "Lets your phone connect to Maple Atlas Companion over your Wi-Fi."}, {"Grouping", ruleName},
			{"ApplicationName", exe}, {"Protocol", int32(proto)}, {"Direction", int32(fwIn)}, {"Action", int32(fwAllow)}, {"Profiles", int32(fwAll)}, {"Enabled", true}} {
			if _, err := oleutil.PutProperty(rule, kv.k, kv.v); err != nil {
				rule.Release()
				return err
			}
		}
		_, err = oleutil.CallMethod(rules, "Add", rule)
		rule.Release()
		if err != nil {
			return err
		}
	}
	return nil
}

// fixFirewall runs this program again with --repair-firewall as administrator, so
// Windows' approval prompt names Maple Atlas Companion itself.
func fixFirewall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString(exe)
	args, _ := syscall.UTF16PtrFromString("--repair-firewall")
	shell := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	r, _, _ := shell.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), uintptr(unsafe.Pointer(args)), 0, 0)
	if r <= 32 {
		return errors.New("Windows did not allow it")
	}
	return nil
}
