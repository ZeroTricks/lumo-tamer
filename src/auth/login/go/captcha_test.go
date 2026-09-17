package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	proton "github.com/henrybear327/go-proton-api"
)

func hvError() error {
	// Mirrors how catchAPIError wraps the decoded APIError
	return fmt.Errorf("422 POST /auth/v4: %w", &proton.APIError{
		Status:  422,
		Code:    proton.HumanVerificationRequired,
		Message: "Human verification required",
		Details: map[string]any{
			"HumanVerificationToken":   "hv-token-123",
			"HumanVerificationMethods": []any{"captcha", "email"},
		},
	})
}

func TestAsHumanVerification(t *testing.T) {
	hv, ok := asHumanVerification(hvError())
	if !ok {
		t.Fatal("expected human verification details")
	}
	if hv.Token != "hv-token-123" {
		t.Errorf("token = %q", hv.Token)
	}
	if !hv.supportsCaptcha() {
		t.Errorf("expected captcha in methods %v", hv.Methods)
	}
}

func TestAsHumanVerificationOtherErrors(t *testing.T) {
	if _, ok := asHumanVerification(fmt.Errorf("plain error")); ok {
		t.Error("plain error should not parse as human verification")
	}
	if _, ok := asHumanVerification(fmt.Errorf("wrap: %w", &proton.APIError{Code: proton.PasswordWrong})); ok {
		t.Error("non-9001 APIError should not parse as human verification")
	}
}

func TestFriendlyAuthError(t *testing.T) {
	locked := fmt.Errorf("422 POST /auth/v4: %w", &proton.APIError{
		Status: 422, Code: accountLockedCode,
		Message: "Our systems detected unusual activity targeting your account.",
	})
	got := friendlyAuthError(locked)
	if !strings.HasPrefix(got, "Our systems detected unusual activity") {
		t.Errorf("locked message not surfaced: %q", got)
	}
	if !strings.Contains(got, "appeal-abuse") {
		t.Errorf("locked message missing guidance: %q", got)
	}
	if strings.Contains(got, "422 POST") {
		t.Errorf("verbose RESTY prefix not stripped: %q", got)
	}

	wrong := fmt.Errorf("wrap: %w", &proton.APIError{Code: proton.PasswordWrong, Message: "Incorrect login credentials"})
	if got := friendlyAuthError(wrong); !strings.Contains(got, "Incorrect password") {
		t.Errorf("password message = %q", got)
	}

	plain := fmt.Errorf("network is down")
	if got := friendlyAuthError(plain); got != "network is down" {
		t.Errorf("plain error = %q", got)
	}
}

func TestHVTransportInjectsHeaders(t *testing.T) {
	var authToken, authType, infoToken, userToken string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/v4":
			authToken = r.Header.Get("X-Pm-Human-Verification-Token")
			authType = r.Header.Get("X-Pm-Human-Verification-Token-Type")
		case "/api/auth/v4/info":
			infoToken = r.Header.Get("X-Pm-Human-Verification-Token")
		case "/api/core/v4/users":
			userToken = r.Header.Get("X-Pm-Human-Verification-Token")
		}
	}))
	defer upstream.Close()

	client := &http.Client{Transport: newHVTransport(nil, "solved-token", "captcha")}
	for _, request := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/v4/info"},
		{http.MethodPost, "/api/auth/v4"},
		{http.MethodGet, "/api/core/v4/users"},
	} {
		req, err := http.NewRequest(request.method, upstream.URL+request.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}

	if authToken != "solved-token" || authType != "captcha" {
		t.Errorf("auth headers = %q, %q", authToken, authType)
	}
	if infoToken != "" || userToken != "" {
		t.Errorf("verification token leaked to other requests: info=%q user=%q", infoToken, userToken)
	}
}

func TestCaptchaProxyStripsCSP(t *testing.T) {
	var upstreamHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/core/v4/captcha" {
			t.Errorf("upstream path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Security-Policy", "frame-ancestors https://calendar.proton.me;")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Location", "http://"+upstreamHost+"/captcha/v1/frame?token=x")
		w.Header().Set("Set-Cookie", "Session-Id=abc; Domain=proton.me; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=31536000; Secure; SameSite=None; HttpOnly")
		w.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()
	upstreamHost = strings.TrimPrefix(upstream.URL, "http://")

	proxy, err := newCaptchaProxy(upstream.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(proxy)
	defer local.Close()

	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := client.Get(local.URL + "/core/v4/captcha?Token=x")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if h := res.Header.Get("Content-Security-Policy"); h != "" {
		t.Errorf("CSP not stripped: %q", h)
	}
	if h := res.Header.Get("X-Frame-Options"); h != "" {
		t.Errorf("X-Frame-Options not stripped: %q", h)
	}
	if loc := res.Header.Get("Location"); loc != "/captcha/v1/frame?token=x" {
		t.Errorf("Location not made proxy-relative: %q", loc)
	}
	if c := res.Header.Get("Set-Cookie"); c != "Session-Id=abc; Path=/; HttpOnly" {
		t.Errorf("cookie attrs not stripped (persistence must not survive the session): %q", c)
	}
}

func TestLegacyTarget(t *testing.T) {
	legacy := legacyTarget("hv 123")
	if legacy.upstream != "https://mail-api.proton.me" {
		t.Errorf("legacy upstream = %q", legacy.upstream)
	}
	if legacy.iframeSrc != "/core/v4/captcha?Token=hv+123&ForceWebMessaging=1" {
		t.Errorf("legacy iframeSrc = %q", legacy.iframeSrc)
	}
}

func TestCaptchaServer(t *testing.T) {
	srv, err := startCaptchaServer(legacyTarget("hv-token-123"), "user@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.close()

	res, err := http.Get(srv.localURL)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(res.Body)
	res.Body.Close()

	if !strings.Contains(string(page), "core/v4/captcha?Token=hv-token-123") {
		t.Errorf("page missing captcha iframe URL:\n%s", page)
	}
	// The account being signed in is shown so multiple sequential CAPTCHAs
	// (one per account) are distinguishable.
	if !strings.Contains(string(page), "user@example.test") {
		t.Errorf("page missing account label:\n%s", page)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := res.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q", got)
	}
	// The login page must match the Proton web client's message handling
	// (pm_captcha only); proton_captcha is scoped to the --captcha-test app.
	if !strings.Contains(string(page), "pm_captcha") {
		t.Error("login page missing pm_captcha handling")
	}
	if strings.Contains(string(page), "proton_captcha") {
		t.Error("login page must not handle proton_captcha (web client uses pm_captcha only)")
	}

	res, err = http.Post(srv.localURL+"submit", "text/plain", strings.NewReader("solved-token"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("submit status = %d", res.StatusCode)
	}

	select {
	case token := <-srv.tokenCh:
		if token != "solved-token" {
			t.Errorf("token = %q", token)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for token")
	}
}

// The server must not be reachable under a foreign Host (DNS rebinding) and
// /submit must refuse cross-origin posts; the legitimate page and its
// same-origin fetch keep working.
func TestCaptchaServerRejectsForeignHostAndOrigin(t *testing.T) {
	srv, err := startCaptchaServer(legacyTarget("hv-token-123"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.close()

	rebound, err := http.NewRequest(http.MethodGet, srv.localURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	rebound.Host = "evil.example"
	res, err := http.DefaultClient.Do(rebound)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("foreign Host status = %d, want %d", res.StatusCode, http.StatusMisdirectedRequest)
	}

	crossOrigin, err := http.NewRequest(http.MethodPost, srv.localURL+"submit", strings.NewReader("spoofed"))
	if err != nil {
		t.Fatal(err)
	}
	crossOrigin.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(crossOrigin)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin submit status = %d, want %d", res.StatusCode, http.StatusForbidden)
	}
	select {
	case token := <-srv.tokenCh:
		t.Errorf("spoofed token was accepted: %q", token)
	default:
	}

	sameOrigin, err := http.NewRequest(http.MethodPost, srv.localURL+"submit", strings.NewReader("real-token"))
	if err != nil {
		t.Fatal(err)
	}
	sameOrigin.Header.Set("Origin", strings.TrimSuffix(srv.localURL, "/"))
	res, err = http.DefaultClient.Do(sameOrigin)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Errorf("same-origin submit status = %d, want 200", res.StatusCode)
	}
	select {
	case token := <-srv.tokenCh:
		if token != "real-token" {
			t.Errorf("token = %q", token)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for token")
	}
}
