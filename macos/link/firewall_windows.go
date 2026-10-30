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
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

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
	firewallCommand = func(args []string) int {
		var err error
		switch args[0] {
		case "--repair-firewall":
			method, output, rerr := repairSelf()
			err = rerr
			// The window that asked for the repair waits for this file (it cannot see an
			// elevated program's output).
			if len(args) > 1 {
				result := map[string]any{"ok": err == nil, "method": method, "output": output, "after": firewallStatus()}
				if err != nil {
					result["error"] = err.Error()
				}
				b, _ := json.MarshalIndent(result, "", "  ")
				os.WriteFile(args[1], b, 0o644)
			}
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

// selfPath: this program's path as Windows resolves it (junctions and short names
// followed), which is how the firewall compares a rule's program to a connection.
func selfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved, nil
	}
	return exe, nil
}

// samePath: two program paths that mean the same file.
func samePath(a, b string) bool {
	norm := func(p string) string {
		p = expandWindowsVars(p)
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		return strings.ToLower(filepath.Clean(p))
	}
	return norm(a) == norm(b)
}

// ownRules lists the inbound rules that name this program, however Windows stored
// the path (letter case, %ProgramFiles%, short names).
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
		if app == "" || !samePath(app, exe) {
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
	exe, err := selfPath()
	if err != nil {
		return firewallReport{State: "unknown", Detail: "Could not find this program's path: " + err.Error()}
	}
	var report firewallReport
	err = withFirewall(func(policy *ole.IDispatch) error {
		defer func() {
			report.Exe = exe
			report.Policy = policyState(policy)
			report.Related = relatedRules(policy)
			var hb []string
			for _, p := range []int{fwDomain, fwPrivate, fwPublic} {
				if current&p == 0 {
					continue
				}
				if d := prop(policy, "UnicastResponsesToMulticastBroadcastDisabled", p); d != nil && d.Value() == true {
					hb = append(hb, profileNames[p]+": replies blocked by policy")
				} else {
					hb = append(hb, profileNames[p]+": replies accepted for 3 s after each heartbeat")
				}
			}
			report.Heartbeat = strings.Join(hb, "; ")
		}()
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
		var profiles []string
		for _, p := range active {
			profiles = append(profiles, profileNames[p])
		}
		defer func() { report.Profiles = profiles }()
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
		defer func() { report.Rules = describeRules(rules) }()
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
				// Windows' own prompt, answered with only "Private networks" ticked (its
				// default), allows the app on Private networks and blocks it on Public ones;
				// Windows 11 puts new Wi-Fi networks on Public.
				allowedElsewhere := false
				for _, r := range rules {
					if udp(r) && r.action == fwAllow && r.profiles&p == 0 {
						allowedElsewhere = true
					}
				}
				detail := "Windows Firewall has a rule that blocks Maple Atlas Companion on this " + profileNames[p] + " network."
				if allowedElsewhere {
					detail = "Windows allowed Maple Atlas Companion on other network types only (the ticked boxes in its own prompt) and blocked it on this " + profileNames[p] + " network, which is what this Wi-Fi counts as."
				}
				report = firewallReport{State: "blocked", Detail: detail}
				return nil
			}
			if !allowed && missing == "" {
				missing = profileNames[p]
			}
		}
		if missing != "" {
			report = firewallReport{State: "missing", Detail: "Maple Atlas Companion is not allowed on this " + missing + " network yet (Windows puts most new Wi-Fi networks on \"public\")."}
		} else {
			report = firewallReport{State: "ok"}
		}
		return nil
	})
	report.Others = otherFirewalls()
	if err != nil {
		// Shown in the window and the log: another security program may have replaced
		// Windows Firewall, or its service is stopped.
		report.State, report.Detail = "unknown", "Could not check Windows Firewall: "+err.Error()
	}
	return report
}

// policyState: whether rules added here can take effect at all.
func policyState(policy *ole.IDispatch) string {
	switch intOf(prop(policy, "LocalPolicyModifyState")) {
	case 1:
		return "group policy overrides local rules (a managed PC: an administrator must allow the app)"
	case 2:
		return "all inbound connections are blocked by policy"
	}
	return "ok"
}

// otherFirewalls: firewall products registered with Windows Security besides Windows
// Firewall, with whether they report themselves on.
func otherFirewalls() []string {
	var out []string
	withCOM(func() error {
		unknown, err := oleutil.CreateObject("WbemScripting.SWbemLocator")
		if err != nil {
			return err
		}
		defer unknown.Release()
		locator, err := unknown.QueryInterface(ole.IID_IDispatch)
		if err != nil {
			return err
		}
		defer locator.Release()
		serviceV, err := oleutil.CallMethod(locator, "ConnectServer", ".", `root\SecurityCenter2`)
		if err != nil {
			return err
		}
		service := serviceV.ToIDispatch()
		defer service.Release()
		resultV, err := oleutil.CallMethod(service, "ExecQuery", "SELECT displayName, productState FROM FirewallProduct")
		if err != nil {
			return err
		}
		result := resultV.ToIDispatch()
		defer result.Release()
		return oleutil.ForEach(result, func(v *ole.VARIANT) error {
			item := v.ToIDispatch()
			if item == nil {
				return nil
			}
			defer item.Release()
			name := ""
			if n := prop(item, "displayName"); n != nil {
				name = n.ToString()
			}
			state := intOf(prop(item, "productState"))
			on := "off"
			if state&0x1000 != 0 {
				on = "on"
			}
			if name != "" && !strings.Contains(strings.ToLower(name), "windows") {
				out = append(out, fmt.Sprintf("%s (%s, state 0x%x)", name, on, state))
			}
			return nil
		})
	})
	return out
}

// withCOM runs fn on a COM-initialized thread.
func withCOM(fn func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		if oe, ok := err.(*ole.OleError); !ok || oe.Code() != 1 {
			return err
		}
	}
	defer ole.CoUninitialize()
	return fn()
}

// relatedRules: every inbound rule whose name or program mentions the app, exactly as
// Windows stores it. A rule for another copy (an old install path, a download folder) shows
// up here and not in the app's own rules.
func relatedRules(policy *ole.IDispatch) []string {
	rulesV, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		return []string{"could not list rules: " + err.Error()}
	}
	rules := rulesV.ToIDispatch()
	defer rules.Release()
	var out []string
	oleutil.ForEach(rules, func(v *ole.VARIANT) error {
		d := v.ToIDispatch()
		if d == nil {
			return nil
		}
		defer d.Release()
		text := func(name string) string {
			if p := prop(d, name); p != nil {
				return p.ToString()
			}
			return ""
		}
		name, app := text("Name"), text("ApplicationName")
		if intOf(prop(d, "Direction")) != fwIn || !(strings.Contains(strings.ToLower(name), "maple") || strings.Contains(strings.ToLower(app), "maple")) {
			return nil
		}
		action := map[int]string{fwBlock: "Block", fwAllow: "Allow"}[intOf(prop(d, "Action"))]
		proto := map[int]string{protoTCP: "TCP", protoUDP: "UDP", protoAny: "any", 0: "any"}[intOf(prop(d, "Protocol"))]
		enabled := "off"
		if e := prop(d, "Enabled"); e != nil && e.Value() == true {
			enabled = "on"
		}
		profiles := intOf(prop(d, "Profiles"))
		var on []string
		for _, p := range []int{fwDomain, fwPrivate, fwPublic} {
			if profiles&p != 0 {
				on = append(on, profileNames[p])
			}
		}
		extra := ""
		for _, k := range []string{"LocalPorts", "RemoteAddresses", "InterfaceTypes", "serviceName", "Grouping"} {
			if t := text(k); t != "" && t != "*" && t != "All" {
				extra += " " + k + "=" + t
			}
		}
		out = append(out, fmt.Sprintf("%q: %s %s on %s · %s · program %q%s", name, action, proto, strings.Join(on, ","), enabled, app, extra))
		return nil
	})
	return out
}

// repairSelf allows this program through Windows Firewall: through the firewall API, else
// (or when MAPLE_LINK_FIREWALL_METHOD=netsh) with netsh, Windows' own command. Returns the
// method used and netsh's output.
func repairSelf() (method, output string, err error) {
	if os.Getenv("MAPLE_LINK_FIREWALL_METHOD") != "netsh" {
		if err = withFirewall(allowSelf); err == nil {
			if after := firewallStatus(); after.State == "ok" || after.State == "shielded" {
				return "com", "", nil
			}
			err = errors.New("the rules were added but Windows still reports: " + firewallStatus().Detail)
		}
	}
	comErr := err
	exe, exeErr := selfPath()
	if exeErr != nil {
		return "com", "", exeErr
	}
	output, err = netshRepair(exe)
	if err != nil {
		if comErr != nil {
			err = fmt.Errorf("firewall API: %v; netsh: %v", comErr, err)
		}
		return "netsh", output, err
	}
	return "netsh", output, nil
}

// netshRepair removes every inbound rule for the program and adds allow rules with netsh.
func netshRepair(exe string) (string, error) {
	var log strings.Builder
	run := func(args ...string) error {
		cmd := exec.Command("netsh", append([]string{"advfirewall", "firewall"}, args...)...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		out, err := cmd.CombinedOutput()
		fmt.Fprintf(&log, "> netsh advfirewall firewall %s\n%s", strings.Join(args, " "), strings.TrimSpace(string(out)))
		if err != nil {
			fmt.Fprintf(&log, "\n(%v)", err)
			return fmt.Errorf("%s: %s", args[0], strings.TrimSpace(string(out)))
		}
		log.WriteString("\n")
		return nil
	}
	// Deleting rules that do not exist is an error for netsh: not one for us.
	run("delete", "rule", "name=all", "dir=in", "program="+exe)
	for _, proto := range []string{"udp", "tcp"} {
		if err := run("add", "rule", "name="+ruleName, "dir=in", "action=allow", "program="+exe, "enable=yes", "profile=any", "protocol="+proto,
			"description=Lets your phone connect to Maple Atlas Companion over your Wi-Fi."); err != nil {
			return log.String(), err
		}
	}
	return log.String(), nil
}

// openFirewallSettings opens Windows' own "Allow an app through Windows Firewall" page.
func openFirewallSettings() error {
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString("control.exe")
	args, _ := syscall.UTF16PtrFromString("/name Microsoft.WindowsFirewall /page pageConfigureApps")
	shell := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	r, _, _ := shell.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), uintptr(unsafe.Pointer(args)), 0, 1)
	if r <= 32 {
		return errors.New("Windows could not open the firewall settings")
	}
	return nil
}

// describeRules: "Allow UDP on private, public · on · Maple Atlas Companion".
func describeRules(rules []fwRule) []string {
	var out []string
	for _, r := range rules {
		action := map[int]string{fwBlock: "Block", fwAllow: "Allow"}[r.action]
		proto := map[int]string{protoTCP: "TCP", protoUDP: "UDP", protoAny: "any", 0: "any"}[r.proto]
		var on []string
		for _, p := range []int{fwDomain, fwPrivate, fwPublic} {
			if r.profiles&p != 0 {
				on = append(on, profileNames[p])
			}
		}
		state := "off"
		if r.enabled {
			state = "on"
		}
		out = append(out, action+" "+proto+" on "+strings.Join(on, ", ")+" · "+state+" · "+r.name)
	}
	return out
}

// removeSelf deletes every inbound rule for this program, including "block" rules
// Windows saved when its prompt was cancelled.
func removeSelf(policy *ole.IDispatch) error {
	exe, err := selfPath()
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
	exe, err := selfPath()
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

// fixFirewall runs this program again with --repair-firewall as administrator (Windows'
// approval prompt names Maple Atlas Companion itself) and waits for it, so the window can
// say what happened: declined, failed (and why), or done.
func fixFirewall(stateDir string) firewallRepair {
	exe, err := os.Executable()
	if err != nil {
		return firewallRepair{Error: err.Error()}
	}
	result := filepath.Join(stateDir, "firewall-repair.json")
	os.Remove(result)
	type shellExecuteInfo struct {
		Size                        uint32
		Mask                        uint32
		Hwnd                        uintptr
		Verb, File, Parameters, Dir *uint16
		Show                        int32
		InstApp, IDList             uintptr
		Class                       *uint16
		KeyClass                    uintptr
		HotKey                      uint32
		IconOrMonitor, Process      uintptr
	}
	const maskNoCloseProcess, maskNoAsync, maskFlagNoUI = 0x40, 0x100, 0x400
	info := shellExecuteInfo{Mask: maskNoCloseProcess | maskNoAsync}
	info.Size = uint32(unsafe.Sizeof(info))
	info.Verb, _ = syscall.UTF16PtrFromString("runas")
	info.File, _ = syscall.UTF16PtrFromString(exe)
	info.Parameters, _ = syscall.UTF16PtrFromString(`--repair-firewall "` + result + `"`)
	shell := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteExW")
	ok, _, callErr := shell.Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		if errno, isErrno := callErr.(syscall.Errno); isErrno && errno == 1223 { // ERROR_CANCELLED
			return firewallRepair{Error: "Windows asked for approval and the answer was No."}
		}
		return firewallRepair{Error: "Windows could not start the repair: " + callErr.Error()}
	}
	out := firewallRepair{Approved: true}
	if info.Process == 0 {
		out.Error = "Windows started the repair but gave no way to follow it."
		return out
	}
	defer syscall.CloseHandle(syscall.Handle(info.Process))
	if ev, _ := syscall.WaitForSingleObject(syscall.Handle(info.Process), 60000); ev != syscall.WAIT_OBJECT_0 {
		out.Error = "The repair did not finish within a minute."
		return out
	}
	var code uint32
	syscall.GetExitCodeProcess(syscall.Handle(info.Process), &code)
	out.Exit, out.Finished = int(code), true
	var r struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Method string `json:"method"`
		Output string `json:"output"`
	}
	if b, err := os.ReadFile(result); err != nil {
		out.Error = "The repair ran (exit " + strconv.Itoa(int(code)) + ") but left no result: " + err.Error()
	} else if json.Unmarshal(b, &r) == nil && !r.OK {
		out.Method, out.Output = r.Method, r.Output
		out.Error = "The repair failed: " + r.Error
	} else if json.Unmarshal(b, &r) == nil && r.OK {
		out.Method, out.Output = r.Method, r.Output
	} else if code != 0 {
		out.Error = "The repair stopped with code " + strconv.Itoa(int(code)) + "."
	}
	return out
}
