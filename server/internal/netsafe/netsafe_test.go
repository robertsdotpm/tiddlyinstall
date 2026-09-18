package netsafe

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestPublic(t *testing.T) {
	for s, want := range map[string]bool{
		"8.8.8.8": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.0.1.76": false, "192.168.1.1": false, "172.16.0.1": false,
		"169.254.169.254": false, "100.64.0.1": false, "::1": false, "fe80::1": false,
		"fd00::1": false, "0.0.0.0": false, "::ffff:127.0.0.1": false,
	} {
		if got := Public(netip.MustParseAddr(s)); got != want {
			t.Errorf("%s: %v", s, got)
		}
	}
}

func TestClientRefusesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	if _, err := Client(5 * time.Second).Get(srv.URL); err == nil {
		t.Fatal("fetched a loopback URL")
	}
}
