package main

import (
	"fmt"
	"net/http"
	"net/url"
)

// proxyTransport returns an http.RoundTripper that routes through proxyURL
// (e.g. http://user:pass@host:port). An empty proxyURL yields the default
// transport. The login and the captcha widget both use it so every
// Proton-facing request exits from the IP the HumanVerificationToken was
// issued to.
func proxyTransport(proxyURL string) (http.RoundTripper, error) {
	if proxyURL == "" {
		return http.DefaultTransport, nil
	}
	u, err := url.Parse(proxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid --proxy URL %q: %w", proxyURL, err)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(u)
	return tr, nil
}
