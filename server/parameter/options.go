package parameter

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/evilmonkeyinc/jsonpath"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

const (
	maxResponseSize      = 2 << 20
	maxOptions           = 1000
	maxOptionTextSize    = 512
	requestTimeout       = 10 * time.Second
	maxConcurrentFetches = 32
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// ParseHosts validates ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS. Entries that look
// like a URL, wildcard, or IP never match a request, so reject them at startup
// instead of silently ignoring them.
func ParseHosts(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	hosts := map[string]struct{}{}
	for raw := range strings.SplitSeq(value, ",") {
		host := strings.ToLower(strings.TrimSpace(raw))
		valid := len(host) <= 253 && strings.Contains(host, ".") && net.ParseIP(host) == nil
		for label := range strings.SplitSeq(host, ".") {
			valid = valid && dnsLabel.MatchString(label)
		}
		if !valid {
			return nil, fmt.Errorf("invalid parameter source hostname %q: use exact DNS hostnames without scheme, port, or wildcard", raw)
		}
		hosts[host] = struct{}{}
	}
	result := make([]string, 0, len(hosts))
	for host := range hosts {
		result = append(result, host)
	}
	sort.Strings(result)
	return result, nil
}

// OptionsHandler fetches allowlisted JSON sources and maps them to selectable options.
type OptionsHandler struct {
	allowedHosts map[string]struct{}
	client       *http.Client
	fetchSlots   chan struct{}
	mu           sync.Mutex
	limits       map[[32]byte]*identityLimit
	cache        map[string]cachedBody
}

type identityLimit struct {
	limiter  *rate.Limiter
	lastUsed time.Time
}

type cachedBody struct {
	body    []byte
	expires time.Time
}

// OptionsHandlerConfig configures an OptionsHandler.
type OptionsHandlerConfig struct {
	AllowedHosts []string
}

// Option is a label/value pair returned to the submission UI.
type Option struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type optionsResponse struct {
	Items []Option `json:"items"`
}

// NewOptionsHandler creates a handler for endpoint-backed parameter options.
func NewOptionsHandler(config OptionsHandlerConfig) *OptionsHandler {
	allowedHosts := make(map[string]struct{}, len(config.AllowedHosts))
	for _, host := range config.AllowedHosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			allowedHosts[host] = struct{}{}
		}
	}

	return &OptionsHandler{
		allowedHosts: allowedHosts,
		fetchSlots:   make(chan struct{}, maxConcurrentFetches),
		limits:       make(map[[32]byte]*identityLimit),
		cache:        make(map[string]cachedBody),
		client: &http.Client{
			Timeout:   requestTimeout,
			Transport: safeTransport(),
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 || (len(via) > 0 && len(via[0].Header) > 0 && !strings.EqualFold(req.URL.Host, via[0].URL.Host)) {
					return errors.New("parameter source redirect is not permitted")
				}
				if err := validateURL(req.URL, allowedHosts); err != nil {
					return err
				}
				return nil
			},
		},
	}
}

func (h *OptionsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "only GET is supported")
		return
	}

	if !h.allowIdentity(r) {
		writeError(w, http.StatusTooManyRequests, "parameter source request limit exceeded")
		return
	}
	configMapName := r.URL.Query().Get("configMapName")
	if err := h.authorizeSource(r); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if configMapName != "" {
		h.serveConfigMap(w, r, configMapName)
		return
	}
	parsedURL, err := url.Parse(r.URL.Query().Get("url"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid url")
		return
	}
	if err = validateURL(parsedURL, h.allowedHosts); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	cacheKey := ""
	if r.URL.Query().Get("secretName") == "" {
		q := r.URL.Query()
		cacheKey = q.Get("templateKind") + "/" + q.Get("namespace") + "/" + q.Get("templateName") + "/" + q.Get("sourceUID") + "/" + q.Get("sourceVersion") + "/" + q.Get("parameterName") + "/" + parsedURL.String()
		if body := h.cached(cacheKey); body != nil {
			h.writeOptions(w, r, body)
			return
		}
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid url")
		return
	}
	if err = h.addSecretHeader(request, r); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	select {
	case h.fetchSlots <- struct{}{}:
		defer func() { <-h.fetchSlots }()
	default:
		writeError(w, http.StatusTooManyRequests, "parameter source is busy")
		return
	}
	response, err := h.client.Do(request)
	if err != nil {
		logging.RequireLoggerFromContext(r.Context()).WithError(err).Error(r.Context(), "failed to fetch parameter options")
		writeError(w, http.StatusBadGateway, "failed to fetch parameter options")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("parameter source returned HTTP %d", response.StatusCode))
		return
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize+1))
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to read parameter source")
		return
	}
	if len(body) > maxResponseSize {
		writeError(w, http.StatusBadGateway, "parameter source response is too large")
		return
	}

	if h.writeOptions(w, r, body) && cacheKey != "" {
		h.storeCached(cacheKey, body)
	}
}

func (h *OptionsHandler) allowIdentity(r *http.Request) bool {
	credential := r.Header.Get("Authorization")
	if credential == "" {
		if cookie, err := r.Cookie("authorization"); err == nil {
			credential = cookie.Value
		}
	}
	key := sha256.Sum256([]byte(credential))
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.limits[key]
	if entry == nil {
		if len(h.limits) >= 1024 {
			for key, existing := range h.limits {
				if now.Sub(existing.lastUsed) > time.Minute {
					delete(h.limits, key)
				}
			}
			if len(h.limits) >= 1024 {
				return false
			}
		}
		entry = &identityLimit{limiter: rate.NewLimiter(rate.Limit(5), 10)}
		h.limits[key] = entry
	}
	entry.lastUsed = now
	return entry.limiter.Allow()
}

func (h *OptionsHandler) cached(key string) []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry, ok := h.cache[key]
	if ok && time.Now().Before(entry.expires) {
		return entry.body
	}
	delete(h.cache, key)
	return nil
}

func (h *OptionsHandler) storeCached(key string, body []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.cache) >= 256 {
		for key, entry := range h.cache {
			if time.Now().After(entry.expires) {
				delete(h.cache, key)
			}
		}
		if len(h.cache) >= 256 {
			return
		}
	}
	h.cache[key] = cachedBody{body: body, expires: time.Now().Add(30 * time.Second)}
}

func (h *OptionsHandler) serveConfigMap(w http.ResponseWriter, r *http.Request, name string) {
	query := r.URL.Query()
	namespace := query.Get("namespace")
	key := query.Get("configMapKey")
	if namespace == "" || key == "" {
		writeError(w, http.StatusBadRequest, "namespace and configMapKey are required for a ConfigMap source")
		return
	}
	readNamespace := query.Get("configMapNamespace")
	if readNamespace == "" {
		readNamespace = namespace
	}
	configMap, err := auth.GetKubeClient(r.Context()).CoreV1().ConfigMaps(readNamespace).Get(r.Context(), name, metav1.GetOptions{})
	if err != nil {
		switch {
		case apierrors.IsForbidden(err):
			writeError(w, http.StatusForbidden, "reading the parameter source ConfigMap is not permitted")
		case apierrors.IsNotFound(err):
			writeError(w, http.StatusNotFound, "parameter source ConfigMap was not found")
		default:
			writeError(w, http.StatusBadGateway, "could not read the parameter source ConfigMap")
		}
		return
	}
	data, ok := configMap.Data[key]
	if !ok {
		writeError(w, http.StatusNotFound, "parameter source ConfigMap key was not found")
		return
	}
	if len(data) > maxResponseSize {
		writeError(w, http.StatusBadGateway, "parameter source response is too large")
		return
	}
	h.writeOptions(w, r, []byte(data))
}

func (h *OptionsHandler) writeOptions(w http.ResponseWriter, r *http.Request, body []byte) bool {
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		writeError(w, http.StatusBadGateway, "parameter source did not return valid JSON")
		return false
	}
	items, err := mapOptions(document, r.URL.Query().Get("itemsPath"), r.URL.Query().Get("labelPath"), r.URL.Query().Get("valuePath"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return false
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(optionsResponse{Items: items})
	return true
}

func (h *OptionsHandler) addSecretHeader(request *http.Request, r *http.Request) error {
	secretName := r.URL.Query().Get("secretName")
	if secretName == "" {
		return nil
	}
	kube, ok := r.Context().Value(auth.KubeKey).(kubernetes.Interface)
	if !ok || kube == nil {
		return errors.New("secret-backed parameter sources require an authenticated Kubernetes client")
	}
	secretNamespace := r.URL.Query().Get("secretNamespace")
	secretKey := r.URL.Query().Get("secretKey")
	headerName := r.URL.Query().Get("header")
	if secretNamespace == "" || secretKey == "" || headerName == "" {
		return errors.New("secretNamespace, secretKey, and header are required with secretName")
	}
	secret, err := kube.CoreV1().Secrets(secretNamespace).Get(r.Context(), secretName, metav1.GetOptions{})
	if err != nil {
		logging.RequireLoggerFromContext(r.Context()).WithError(err).Warn(r.Context(), "failed to read parameter source secret")
		return errors.New("reading the parameter source secret is not permitted")
	}
	value, ok := secret.Data[secretKey]
	if !ok {
		return fmt.Errorf("parameter source secret key %q was not found", secretKey)
	}
	request.Header.Set(headerName, string(value))
	return nil
}

func mapOptions(document any, itemsPath, labelPath, valuePath string) ([]Option, error) {
	items := document
	if itemsPath != "" {
		var err error
		items, err = query(document, itemsPath)
		if err != nil {
			return nil, fmt.Errorf("invalid itemsPath: %w", err)
		}
	}

	array, ok := items.([]any)
	if !ok {
		return nil, errors.New("itemsPath must resolve to an array")
	}
	if len(array) > maxOptions {
		return nil, fmt.Errorf("parameter source returned %d options; the limit is %d", len(array), maxOptions)
	}
	options := make([]Option, 0, len(array))
	for _, item := range array {
		if labelPath == "" && valuePath == "" {
			value, ok := item.(string)
			if !ok {
				return nil, errors.New("labelPath and valuePath are required for object items")
			}
			if len(value) > maxOptionTextSize {
				return nil, fmt.Errorf("parameter option text must be at most %d characters", maxOptionTextSize)
			}
			options = append(options, Option{Label: value, Value: value})
			continue
		}
		label, err := optionValue(item, labelPath)
		if err != nil {
			return nil, fmt.Errorf("invalid labelPath: %w", err)
		}
		value, err := optionValue(item, valuePath)
		if err != nil {
			return nil, fmt.Errorf("invalid valuePath: %w", err)
		}
		if len(label) > maxOptionTextSize || len(value) > maxOptionTextSize {
			return nil, fmt.Errorf("parameter option text must be at most %d characters", maxOptionTextSize)
		}
		options = append(options, Option{Label: label, Value: value})
	}
	return options, nil
}

func optionValue(item any, path string) (string, error) {
	value, err := query(item, path)
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("path %q did not resolve to a string", path)
	}
	return text, nil
}

func query(document any, path string) (any, error) {
	if !strings.HasPrefix(path, "$") {
		path = "$." + path
	}
	return jsonpath.Query(path, document)
}

func validateURL(sourceURL *url.URL, allowedHosts map[string]struct{}) error {
	if sourceURL.Scheme != "https" {
		return errors.New("parameter sources must use HTTPS")
	}
	if sourceURL.User != nil || (sourceURL.Port() != "" && sourceURL.Port() != "443") {
		return errors.New("parameter sources cannot embed credentials or use a nonstandard port")
	}
	host := strings.ToLower(sourceURL.Hostname())
	if host == "" {
		return errors.New("parameter source host is required")
	}
	if _, ok := allowedHosts[host]; !ok {
		return fmt.Errorf("parameter source host %q is not allowlisted", host)
	}
	if ip := net.ParseIP(host); ip != nil && isPrivateIP(ip) {
		return errors.New("parameter source cannot target a private network")
	}
	return nil
}

func safeTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = safeDialContext
	// An environment proxy would resolve and connect outside our private-network checks.
	transport.Proxy = nil
	return transport
}

func safeDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if isPrivateIP(ip.IP) {
			continue
		}
		connection, err := (&net.Dialer{Timeout: requestTimeout}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return connection, nil
		}
	}
	return nil, errors.New("parameter source resolved to a private or unreachable network")
}

var blockedNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64 can route to private IPv4 addresses.
	netip.MustParsePrefix("100.64.0.0/10"), // Shared address space, often routed inside clusters.
	netip.MustParsePrefix("198.18.0.0/15"), // Benchmark networks.
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2001::/32"), // Teredo tunnels can route to private IPv4 addresses.
	netip.MustParsePrefix("2002::/16"), // 6to4 tunnels can route to private IPv4 addresses.
}

func isPrivateIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return true
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	address = address.Unmap()
	for _, prefix := range blockedNetworks {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}
