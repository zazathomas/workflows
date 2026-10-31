package runaction

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// Hostnames are an administrator-controlled UI navigation policy, not a network
// egress allowlist. Keep this separate from the parameter-source egress policy.
var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func ParseHosts(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	hosts := map[string]struct{}{}
	for _, raw := range strings.Split(value, ",") {
		host := strings.ToLower(strings.TrimSpace(raw))
		valid := len(host) <= 253 && strings.Contains(host, ".") && net.ParseIP(host) == nil
		for _, label := range strings.Split(host, ".") {
			valid = valid && dnsLabel.MatchString(label)
		}
		if !valid {
			return nil, fmt.Errorf("invalid run action hostname %q: use exact DNS hostnames without scheme, port, or wildcard", raw)
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

func NewPolicyHandler(hosts []string) http.Handler {
	if hosts == nil {
		hosts = []string{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_ = json.NewEncoder(w).Encode(struct {
			AllowedHosts []string `json:"allowedHosts"`
		}{AllowedHosts: hosts})
	})
}
