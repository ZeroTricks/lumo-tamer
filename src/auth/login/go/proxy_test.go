package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestProxyTransportEmpty(t *testing.T) {
	tr, err := proxyTransport("")
	if err != nil {
		t.Fatal(err)
	}
	if tr != http.DefaultTransport {
		t.Errorf("empty proxy should return the default transport")
	}
}

func TestProxyTransportRoutesThroughProxy(t *testing.T) {
	var hits int32
	// A stand-in HTTP proxy: any request through it increments the counter.
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer proxy.Close()

	tr, err := proxyTransport(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: tr}
	res, err := client.Get("http://example.com/anything")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if atomic.LoadInt32(&hits) == 0 {
		t.Error("request did not go through the proxy")
	}
}

func TestProxyTransportInvalidURL(t *testing.T) {
	if _, err := proxyTransport("://bad"); err == nil {
		t.Error("expected error for malformed proxy URL")
	}
}
