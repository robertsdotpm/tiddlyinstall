// Package netsafe gives the server an HTTP client that only talks to
// public internet addresses, so a user-supplied URL (a source tarball, a
// redirect from one) can't reach this machine or the LAN (SSRF).
package netsafe

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

var ErrBlocked = errors.New("address not allowed")

// Public reports whether an address is on the public internet.
func Public(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsGlobalUnicast() && !a.IsPrivate() && !a.IsLoopback() && !a.IsLinkLocalUnicast() &&
		!cgnat.Contains(a) && !a.IsUnspecified() && !a.IsMulticast()
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// Client returns an http.Client whose every connection, including those
// made after redirects and whatever DNS returns, goes to a public address.
func Client(timeout time.Duration) *http.Client {
	d := &net.Dialer{
		Timeout: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !Public(ap.Addr()) {
				return ErrBlocked
			}
			return nil
		},
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = d.DialContext
	tr.Proxy = nil
	return &http.Client{Timeout: timeout, Transport: tr}
}
