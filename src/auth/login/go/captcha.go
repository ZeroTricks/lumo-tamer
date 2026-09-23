package main

import (
	"context"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/cli/browser"
	proton "github.com/henrybear327/go-proton-api"
)

const captchaTimeout = 10 * time.Minute

// humanVerification holds the parsed Details of a Code=9001 APIError.
type humanVerification struct {
	Token   string
	Methods []string
}

// asHumanVerification extracts human verification details from an auth error.
// ok is false when the error isn't a HumanVerificationRequired APIError, or
// when it carries no token.
func asHumanVerification(err error) (humanVerification, bool) {
	var apiErr *proton.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != proton.HumanVerificationRequired {
		return humanVerification{}, false
	}

	details, ok := apiErr.Details.(map[string]any)
	if !ok {
		return humanVerification{}, false
	}

	hv := humanVerification{}
	hv.Token, _ = details["HumanVerificationToken"].(string)

	if methods, ok := details["HumanVerificationMethods"].([]any); ok {
		for _, m := range methods {
			if s, ok := m.(string); ok {
				hv.Methods = append(hv.Methods, s)
			}
		}
	}

	return hv, hv.Token != ""
}

func (hv humanVerification) supportsCaptcha() bool {
	return slices.Contains(hv.Methods, "captcha")
}

// accountLockedCode is Proton's "unusual activity, access temporarily limited"
// abuse response. It is account/IP-level and time-based, not something the
// client can retry around.
const accountLockedCode proton.Code = 2028

// friendlyAuthError unwraps go-proton-api's "<status> <method> <url>:" error
// prefix down to the API message, then appends guidance for a couple of
// well-known codes (account lock, wrong password).
func friendlyAuthError(err error) string {
	var apiErr *proton.APIError
	if !errors.As(err, &apiErr) {
		return err.Error()
	}

	msg := apiErr.Message
	if msg == "" {
		msg = fmt.Sprintf("Proton returned an error (Code=%d, Status=%d)", apiErr.Code, apiErr.Status)
	}

	switch apiErr.Code {
	case accountLockedCode:
		return msg + "\nThis is an account-level limit from Proton, not a lumo-tamer error. " +
			"Wait a while and retry, ideally after signing in to this account in a normal browser from the same network. " +
			"If it persists, appeal at https://proton.me/support/appeal-abuse"
	case proton.PasswordWrong:
		return "Incorrect password (or username)."
	}
	return msg
}

// hvTransport injects the human verification headers Proton expects on the
// retried login request after the user has solved the challenge.
type hvTransport struct {
	base      http.RoundTripper
	token     string
	tokenType string
}

func (t *hvTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	// The token proves the retried authentication request only. Do not attach
	// it to AuthInfo or to authenticated requests made with the returned client.
	if req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/auth/v4") {
		req.Header.Set("X-Pm-Human-Verification-Token", t.token)
		req.Header.Set("X-Pm-Human-Verification-Token-Type", t.tokenType)
	}
	return t.base.RoundTrip(req)
}

func newHVTransport(base http.RoundTripper, token, tokenType string) *hvTransport {
	if base == nil {
		base = http.DefaultTransport
	}
	return &hvTransport{base: base, token: token, tokenType: tokenType}
}

// captchaPage wraps Proton's captcha page in an iframe and posts the solved
// token back to the local server. The captcha is proxied through this server
// (Proton's CSP forbids framing it from non-Proton origins), so the iframe is
// same-origin. The real login flow speaks Proton's web-messaging format,
// matching the Proton web client: {type: 'pm_captcha', token}, plus
// {type: 'pm_height', height} to size the frame. The --captcha-test smoke
// check renders Proton's self-initialising app, which instead posts
// {type: 'proton_captcha', token, protoncaptcha: true}; that format is wired up
// only for the test (AllowModern), so the login page stays identical to the
// web client's.
var captchaPage = template.Must(template.New("captcha").Parse(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Proton CAPTCHA - lumo-tamer</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 1.5rem auto; padding: 0 1rem; color: #1b1340; }
  h3 { margin: 0 0 .75rem; font-weight: 600; }
  iframe { width: 100%; height: 34rem; border: none; }
  #status { margin-top: .75rem; font-size: .95rem; min-height: 1.4em; }
  #status.ok { color: #1a7f37; font-weight: 600; }
  #status.err { color: #c1121f; font-weight: 600; }
</style>
</head>
<body>
<h3>Solve the CAPTCHA to finish signing in to Proton{{if .Account}} as {{.Account}}{{end}}</h3>
<iframe id="captcha" src="{{.IframeURL}}" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
<p id="status">Waiting for you to solve the challenge above...</p>
<script>
  const iframe = document.getElementById('captcha');
  const status = document.getElementById('status');
  function setStatus(text, cls) { status.textContent = text; status.className = cls || ''; }
  function solved(token) {
    setStatus('Verifying...', '');
    fetch('/submit', { method: 'POST', body: token }).then((r) => {
      if (!r.ok) throw new Error('submit failed');
      iframe.remove();
      setStatus('Verified. This window will close automatically. Return to the terminal.', 'ok');
      // Give the terminal a moment to pick up the token, then close the popup.
      setTimeout(() => window.close(), 1500);
    }).catch(() => {
      setStatus('Could not deliver the token to lumo-tamer. Copy it from the terminal if needed.', 'err');
    });
  }
  window.addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow || !event.data) return;
    const d = event.data;
    if (d.type === 'pm_height' && d.height) {
      iframe.style.height = (d.height + 60) + 'px';
    }
    if ((d.type === 'pm_captcha'{{if .AllowModern}} || d.type === 'proton_captcha' || d.protoncaptcha{{end}}) && d.token) {
      solved(d.token);
    }
  });
</script>
</body>
</html>
`))

// captchaServer serves the wrapper page on a local port, reverse-proxies
// Proton's captcha (stripping the CSP that forbids framing it), and delivers
// the solved captcha token on tokenCh.
type captchaServer struct {
	localURL string
	port     int
	tokenCh  chan string
	server   *http.Server
}

func (s *captchaServer) close() { _ = s.server.Close() }

// captchaHost is the API subdomain matching DefaultHostURL (mail.proton.me/api).
// The captcha must be proxied from the subdomain's root, not the /api prefix:
// with a valid token, /core/v4/captcha hands off to the captcha app at
// root-relative /captcha/v1/..., which only exists on the API subdomain.
const captchaHost = "https://mail-api.proton.me"

// captchaTarget describes what the wrapper page frames: the upstream host to
// reverse-proxy and the iframe src (a path+query relative to the local server).
type captchaTarget struct {
	upstream  string
	iframeSrc string
	modern    bool // the --captcha-test app; see captchaPage for its solve message
}

// legacyTarget renders a real HumanVerificationToken through the /core/v4/captcha
// wrapper, which binds the challenge to that token (it bootstraps into Proton's
// captcha app with the token + purpose). The solved result verifies against
// Proton's token, which is what the login retry needs.
func legacyTarget(hvToken string) captchaTarget {
	return captchaTarget{
		upstream:  captchaHost,
		iframeSrc: "/core/v4/captcha?Token=" + url.QueryEscape(hvToken) + "&ForceWebMessaging=1",
	}
}

// captchaAppHost serves Proton's self-contained CAPTCHA app. Unlike the
// /core/v4/captcha wrapper, /captcha/v1/assets/ self-initialises via
// /captcha/v1/api/init and renders a solvable challenge for any token, so the
// smoke check can show the widget without a live 9001.
const captchaAppHost = "https://account-api.proton.me"

// onDemandTarget renders the self-initialising app for --captcha-test. Its
// token can't authenticate a login (see captchaPage), so the real flow uses
// legacyTarget.
func onDemandTarget() captchaTarget {
	return captchaTarget{
		upstream:  captchaAppHost,
		iframeSrc: "/captcha/v1/assets/?purpose=signup&token=on-demand-test",
		modern:    true,
	}
}

// newCaptchaProxy proxies requests to Proton's API host so the captcha page
// and any resources it fetches are same-origin with the wrapper page.
func newCaptchaProxy(hostURL, proxyURL string) (*httputil.ReverseProxy, error) {
	upstream, err := url.Parse(hostURL)
	if err != nil {
		return nil, err
	}
	tr, err := proxyTransport(proxyURL)
	if err != nil {
		return nil, err
	}

	return &httputil.ReverseProxy{
		Transport: tr,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			pr.Out.Host = upstream.Host
		},
		ModifyResponse: func(res *http.Response) error {
			// Proton's frame-ancestors would block our iframe; the page only
			// needs to run in this throwaway local context.
			res.Header.Del("Content-Security-Policy")
			res.Header.Del("Content-Security-Policy-Report-Only")
			res.Header.Del("X-Frame-Options")

			// Keep upstream redirects on the proxy instead of escaping to
			// the real host (where framing would be blocked again).
			if loc := res.Header.Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil && u.Host == upstream.Host {
					u.Scheme, u.Host = "", ""
					res.Header.Set("Location", u.String())
				}
			}

			// Drop cookie attributes that keep them from sticking on
			// http://127.0.0.1 (Domain=proton.me, Secure, SameSite=None).
			if cookies := res.Header.Values("Set-Cookie"); len(cookies) > 0 {
				rewritten := make([]string, 0, len(cookies))
				for _, c := range cookies {
					rewritten = append(rewritten, stripCookieAttrs(c))
				}
				res.Header.Del("Set-Cookie")
				for _, c := range rewritten {
					res.Header.Add("Set-Cookie", c)
				}
			}
			return nil
		},
	}, nil
}

// stripCookieAttrs removes the Domain, Secure and SameSite attributes so the
// cookie is accepted for the local plain-http proxy origin, and Expires and
// Max-Age so it dies with the browser session. Cookies are not port-scoped:
// a persistent cookie stored for 127.0.0.1 here would ride along to every
// local http server the browser talks to later, and the widget only needs it
// for the minutes the solve takes.
func stripCookieAttrs(cookie string) string {
	parts := strings.Split(cookie, ";")
	kept := parts[:1]
	for _, p := range parts[1:] {
		attr := strings.ToLower(strings.TrimSpace(p))
		if attr == "secure" || strings.HasPrefix(attr, "domain=") || strings.HasPrefix(attr, "samesite=") ||
			strings.HasPrefix(attr, "expires=") || strings.HasPrefix(attr, "max-age=") {
			continue
		}
		kept = append(kept, p)
	}
	return strings.Join(kept, ";")
}

func startCaptchaServer(target captchaTarget, account, proxyURL string) (*captchaServer, error) {
	proxy, err := newCaptchaProxy(target.upstream, proxyURL)
	if err != nil {
		return nil, err
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to start local captcha server: %w", err)
	}

	tokenCh := make(chan string, 1)
	localAddr := listener.Addr().String()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			proxy.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = captchaPage.Execute(w, map[string]any{
			"IframeURL":   target.iframeSrc,
			"AllowModern": target.modern,
			"Account":     account,
		})
	})
	mux.HandleFunc("/submit", func(w http.ResponseWriter, r *http.Request) {
		// A cross-origin POST to 127.0.0.1 is a CORS "simple request" that
		// browsers deliver, so a malicious page could poison the token
		// channel blind. The wrapper page's own fetch is same-origin; its
		// Origin header is either absent or the local origin.
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+localAddr {
			http.Error(w, "cross-origin submit rejected", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil || len(body) == 0 {
			http.Error(w, "empty token", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		select {
		case tokenCh <- string(body):
		default:
		}
	})

	// Requests must carry our own Host. A DNS-rebound domain resolving to
	// 127.0.0.1 would otherwise be same-origin with this server and could
	// read the page (which embeds the HumanVerificationToken) or relay
	// arbitrary requests to Proton through the proxy.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != localAddr {
			http.Error(w, "unexpected host", http.StatusMisdirectedRequest)
			return
		}
		mux.ServeHTTP(w, r)
	})

	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()

	return &captchaServer{
		localURL: fmt.Sprintf("http://%s/", listener.Addr().String()),
		port:     listener.Addr().(*net.TCPAddr).Port,
		tokenCh:  tokenCh,
		server:   server,
	}, nil
}

// solveCaptcha serves Proton's captcha widget on a local HTTP server, opens it
// in the user's browser, and waits for the solved captcha token.
func solveCaptcha(ctx context.Context, target captchaTarget, account string, openBrowser bool, proxyURL string) (string, error) {
	srv, err := startCaptchaServer(target, account, proxyURL)
	if err != nil {
		return "", err
	}
	defer srv.close()

	forAccount := ""
	if account != "" {
		forAccount = " as " + account
	}
	fmt.Fprintf(os.Stderr, "\nProton requires a CAPTCHA to sign in%s.\n", forAccount)
	fmt.Fprintf(os.Stderr, "Open this URL in a browser to solve it: %s\n", srv.localURL)
	fmt.Fprintf(os.Stderr, "(on a headless machine, forward the port first: ssh -L %[1]d:127.0.0.1:%[1]d <host>)\n", srv.port)

	if openBrowser {
		if err := browser.OpenURL(srv.localURL); err == nil {
			fmt.Fprintln(os.Stderr, "Opened the CAPTCHA in your browser.")
		}
	}

	fmt.Fprintln(os.Stderr, "Waiting for CAPTCHA to be solved...")

	select {
	case token := <-srv.tokenCh:
		fmt.Fprintln(os.Stderr, "CAPTCHA solved.")
		return token, nil
	case <-time.After(captchaTimeout):
		return "", fmt.Errorf("timed out waiting for CAPTCHA after %v", captchaTimeout)
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// runCaptchaTest opens Proton's CAPTCHA in a browser without logging in, so the
// local server, browser launch and postMessage wiring can be verified on
// demand. It prints the solved token and returns a process exit code.
func runCaptchaTest() int {
	token, err := solveCaptcha(context.Background(), onDemandTarget(), "", true, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "captcha test ended: %v\n", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "Received captcha token: %s\n", token)
	return 0
}
