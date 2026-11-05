package apiserver

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"google.golang.org/grpc/metadata"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	authcookie "github.com/argoproj/argo-workflows/v4/server/auth/cookie"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// tokenLoginHandler validates caller credentials before creating a browser session.
func (as *argoServer) tokenLoginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host == "" || !strings.EqualFold(origin.Host, r.Host) || (origin.Scheme != "https" && origin.Scheme != "http") ||
		(r.TLS != nil && origin.Scheme != "https") || (strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") && origin.Scheme != "https") {
		http.Error(w, "same-origin request required", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	token := strings.TrimSpace(string(body))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(token, "Bearer ") {
		token = "Bearer " + token
	}
	if strings.HasPrefix(token, "Bearer v2:") {
		http.Error(w, "client authentication is unavailable", http.StatusForbidden)
		return
	}
	logger := as.logger
	if logger == nil {
		logger = logging.NewSlogLogger(logging.Info, logging.Text)
	}
	ctx := logging.WithLogger(r.Context(), logger)
	ctx = metadata.NewIncomingContext(ctx, metadata.Pairs(authcookie.AuthorizationMetadataKey, token))
	authenticated, err := as.gatekeeper.Context(ctx)
	if err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if !auth.CanUseParameterSources(authenticated) {
		http.Error(w, "client authentication is unavailable", http.StatusForbidden)
		return
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	authcookie.SetAuthCookie(w, token, authcookie.NormalizePath(as.baseHRef), time.Time{}, secure)
	w.WriteHeader(http.StatusNoContent)
}
