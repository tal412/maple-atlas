//go:build desktopui && windows

package main

// Windows Firewall drops the phone's connection unless this program is allowed for
// inbound traffic on the current network. The window checks that at launch and, when
// it is missing (or a "block" was saved because the firewall prompt was dismissed),
// offers one button that asks Windows for administrator approval and fixes it.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

type firewallReport struct {
	State  string `json:"state"` // ok, blocked, missing, off, unknown
	Detail string `json:"detail,omitempty"`
}

func powershellEncoded(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, v := range u {
		b[2*i], b[2*i+1] = byte(v), byte(v>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func firewallStatus() firewallReport {
	exe, err := os.Executable()
	if err != nil {
		return firewallReport{State: "unknown"}
	}
	// Rule objects, not netsh text, so a Windows in any language reads the same.
	script := `$ErrorActionPreference='SilentlyContinue'
$p=` + psQuote(exe) + `
$on=@(Get-NetFirewallProfile | Where-Object {$_.Enabled -eq 'True'} | ForEach-Object {"$($_.Name)"})
$cats=@(Get-NetConnectionProfile | ForEach-Object {$c="$($_.NetworkCategory)"; if($c -eq 'DomainAuthenticated'){'Domain'}else{$c}})
$mine=@(Get-NetFirewallApplicationFilter | Where-Object {[Environment]::ExpandEnvironmentVariables("$($_.Program)") -ieq $p})
$rules=@($mine | Get-NetFirewallRule | Where-Object {$_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True'})
$shield=@(Get-NetFirewallProfile | Where-Object {$_.Enabled -eq 'True' -and $_.AllowInboundRules -eq 'False'} | ForEach-Object {"$($_.Name)"})
$covers={param($r,$cat) $f="$($r.Profile)"; $f -eq 'Any' -or $f -match $cat}
$active=@($cats | Where-Object {$on -contains $_})
$blocked=@($rules | Where-Object {$_.Action -eq 'Block'}).Count
$missing=@($active | Where-Object {$cat=$_; -not @($rules | Where-Object {$_.Action -eq 'Allow' -and (& $covers $_ $cat)}).Count})
$shielded=@($active | Where-Object {$shield -contains $_})
[pscustomobject]@{on=$on.Count; active=($active -join ','); blocked=$blocked; missing=($missing -join ','); shielded=($shielded -join ',')} | ConvertTo-Json -Compress`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncoded(script))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil {
		return firewallReport{State: "unknown"}
	}
	var r struct {
		On       int    `json:"on"`
		Active   string `json:"active"`
		Blocked  int    `json:"blocked"`
		Missing  string `json:"missing"`
		Shielded string `json:"shielded"`
	}
	if json.Unmarshal(out, &r) != nil {
		return firewallReport{State: "unknown"}
	}
	switch {
	case r.Shielded != "":
		return firewallReport{State: "shielded", Detail: "Windows Firewall is set to block all incoming connections on this network. In Windows Security > Firewall & network protection > " + r.Shielded + " network, turn off \"Block all incoming connections\"."}
	case r.Blocked > 0:
		return firewallReport{State: "blocked", Detail: "Windows Firewall is set to block Maple Atlas Companion."}
	case r.On == 0:
		return firewallReport{State: "off"}
	case r.Missing != "":
		return firewallReport{State: "missing", Detail: "Maple Atlas Companion is not allowed on this " + strings.ToLower(r.Missing) + " network yet."}
	default:
		return firewallReport{State: "ok"}
	}
}

// fixFirewall replaces this program's inbound rules with "allow" on every network
// type, in a PowerShell window that Windows elevates after asking the user.
func fixFirewall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	script := `$p=` + psQuote(exe) + `
Get-NetFirewallApplicationFilter | Where-Object {[Environment]::ExpandEnvironmentVariables("$($_.Program)") -ieq $p} | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {$_.Direction -eq 'Inbound'} | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Maple Atlas Companion' -Direction Inbound -Program $p -Action Allow -Profile Any -Protocol UDP | Out-Null
New-NetFirewallRule -DisplayName 'Maple Atlas Companion' -Direction Inbound -Program $p -Action Allow -Profile Any -Protocol TCP | Out-Null`
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString("powershell.exe")
	args, _ := syscall.UTF16PtrFromString("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + powershellEncoded(script))
	shell := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	r, _, _ := shell.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), uintptr(unsafe.Pointer(args)), 0, 0)
	if r <= 32 {
		return syscall.Errno(r)
	}
	return nil
}
