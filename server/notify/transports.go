package notify

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	v1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// Transport types (docs/notifications.md). Slack, webhook and PagerDuty are
// HTTPS webhook posts; SMTP sends over TLS.
const (
	TransportSlack     = "slack"
	TransportWebhook   = "webhook"
	TransportPagerDuty = "pagerduty"
	TransportSMTP      = "smtp"
)

// Delivery outcome values (the notify_deliveries_total metric labels and the
// audit events).
const (
	OutcomeDelivered  = "delivered"
	OutcomeError      = "error"
	OutcomeSuppressed = "suppressed"
)

// Transport is one notification destination from the namespace ConfigMap.
// Only the operator-configured fields exist; workflow authors choose
// destinations by name, never by URL.
type Transport struct {
	// Type selects the transport.
	Type string `json:"type"`
	// URL is the webhook URL (slack, webhook, pagerduty when it accepts a
	// full events URL). Either inline or a Secret reference.
	URL Value `json:"url,omitempty"`
	// RoutingKey is the PagerDuty Events v2 routing key (integration key),
	// when URL is unset (the default events endpoint is used).
	RoutingKey Value `json:"routingKey,omitempty"`
	// Severity is the PagerDuty severity for triggering events (default
	// "error").
	Severity string `json:"severity,omitempty"`
	// Headers are extra HTTP headers for the webhook transport.
	Headers map[string]string `json:"headers,omitempty"`
	// SMTP fields (transport "smtp"). Port defaults to 465 (implicit TLS);
	// 587 uses STARTTLS. TLS is required either way.
	Host     string   `json:"host,omitempty"`
	Port     int      `json:"port,omitempty"`
	From     string   `json:"from,omitempty"`
	To       []string `json:"to,omitempty"`
	Username string   `json:"username,omitempty"`
	Password Value    `json:"password,omitempty"`
}

// Value is an inline value or a Secret reference. A Secret must live in the
// ConfigMap's namespace and carry notifications.argoproj.io/allowed=true.
type Value struct {
	Value  string     `json:"value,omitempty"`
	Secret *SecretRef `json:"secret,omitempty"`
}

// SecretRef names a Secret and one of its keys.
type SecretRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

// validate checks the transport is completely configured for its type.
func (t *Transport) validate() error {
	switch t.Type {
	case TransportSlack, TransportWebhook:
		if t.URL.isZero() {
			return fmt.Errorf("%s transport needs a url", t.Type)
		}
	case TransportPagerDuty:
		if t.URL.isZero() && t.RoutingKey.isZero() {
			return fmt.Errorf("pagerduty transport needs a url or a routingKey")
		}
	case TransportSMTP:
		if t.Host == "" || t.From == "" || len(t.To) == 0 {
			return fmt.Errorf("smtp transport needs host, from and to")
		}
		if t.Port != 0 && t.Port != 465 && t.Port != 587 {
			return fmt.Errorf("smtp port must be 465 (implicit TLS) or 587 (STARTTLS), got %d", t.Port)
		}
	default:
		return fmt.Errorf("unknown transport type %q", t.Type)
	}
	return nil
}

func (v *Value) isZero() bool {
	return v.Value == "" && v.Secret == nil
}

// Delivery is the notification the controller asks a sender to deliver.
type Delivery struct {
	// Trigger names the event (started, succeeded, ... or runner-health
	// events).
	Trigger string
	// Subject is the one-line summary.
	Subject string
	// Body is the multi-line detail (may be empty).
	Body string
	// Workflow identifies the run (nil for runner-health events).
	Workflow *WorkflowRef
	// Severity is the PagerDuty severity (default error).
	Severity string
	// DedupeKey deduplicates PagerDuty events (workflow UID plus trigger).
	DedupeKey string
}

// WorkflowRef identifies a workflow in a delivery.
type WorkflowRef struct {
	Name      string
	Namespace string
	Phase     string
	UID       string
}

// sender delivers deliveries through one transport. It is created per
// delivery so credentials are resolved live (a rotated Secret takes effect
// immediately) and never cached in memory.
type sender struct {
	transport  Transport
	kube       kubernetes.Interface
	namespace  string
	allowHosts map[string]struct{}
	client     *http.Client // optional override (tests)
	log        logging.Logger
}

// deliveryResult is the outcome of one delivery attempt.
type deliveryResult struct {
	Outcome string // delivered, error, suppressed
	Detail  string
}

// Deliver sends a delivery to every named destination. Every attempt is
// recorded: the metric counts it, and an audit event on the involved object
// (the workflow, or a runner record stub for runner health) makes the
// delivery visible to operators. The returned map names the outcome per
// destination.
func (c *Controller) Deliver(ctx context.Context, configNamespace string, destinations map[string]Transport, names []string, delivery Delivery) map[string]string {
	outcomes := make(map[string]string, len(names))
	names = append([]string(nil), names...)
	sort.Strings(names)
	for _, name := range names {
		transport, ok := destinations[name]
		if !ok {
			c.countDelivery(delivery.Trigger, "unknown", OutcomeError)
			outcomes[name] = fmt.Sprintf("destination %q is not defined in the %s ConfigMap", name, ConfigMapName)
			continue
		}
		result := c.deliverOne(ctx, configNamespace, name, transport, delivery)
		outcomes[name] = result.Detail
		c.countDelivery(delivery.Trigger, transport.Type, result.Outcome)
	}
	return outcomes
}

// deliverOne delivers to one destination.
func (c *Controller) deliverOne(ctx context.Context, configNamespace, name string, transport Transport, delivery Delivery) deliveryResult {
	log := c.log.WithFields(logging.Fields{"destination": name, "transport": transport.Type, "trigger": delivery.Trigger})
	s := &sender{
		transport:  transport,
		kube:       c.kube,
		namespace:  configNamespace,
		allowHosts: c.allowHosts,
		client:     c.httpClient,
		log:        log,
	}
	if err := transport.validate(); err != nil {
		log.WithError(err).Warn(ctx, "invalid notification destination")
		return deliveryResult{Outcome: OutcomeError, Detail: err.Error()}
	}
	var err error
	switch transport.Type {
	case TransportSlack:
		err = s.postSlack(ctx, delivery)
	case TransportWebhook:
		err = s.postWebhook(ctx, delivery)
	case TransportPagerDuty:
		err = s.postPagerDuty(ctx, delivery)
	case TransportSMTP:
		err = s.sendSMTP(ctx, delivery)
	default:
		err = fmt.Errorf("unknown transport type %q", transport.Type)
	}
	if err != nil {
		log.WithError(err).Warn(ctx, "notification delivery failed")
		return deliveryResult{Outcome: OutcomeError, Detail: err.Error()}
	}
	return deliveryResult{Outcome: OutcomeDelivered, Detail: "delivered"}
}

// httpClient builds the delivery HTTP client: 10s timeout (the
// parameter-source rule), no redirects to other hosts. A test may override
// it with a TLS-trusting client.
var notificationTransport = func() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.MaxConnsPerHost = 16
	return transport
}()

func (s *sender) httpClient() *http.Client {
	if s.client != nil {
		return s.client
	}
	return &http.Client{
		Transport: notificationTransport,
		Timeout:   requestTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host {
				return fmt.Errorf("cross-origin notification redirect refused")
			}
			return s.validateHTTPURL(req.URL)
		},
	}
}

// validateHTTPURL enforces the parameter-source egress rules: HTTPS only,
// no embedded credentials, and a host from the
// ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS policy. The port is not restricted:
// the allowlist is exact-hostname, so any port of an allowlisted host is the
// operator's chosen destination (a nonstandard port cannot widen it).
func (s *sender) validateHTTPURL(u *url.URL) error {
	if u.Scheme != "https" {
		return fmt.Errorf("notification transports must use HTTPS")
	}
	if u.User != nil {
		return fmt.Errorf("notification transports cannot embed credentials")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("notification transport host is required")
	}
	if _, ok := s.allowHosts[host]; !ok {
		return fmt.Errorf("notification host %q is not allowlisted by ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS", host)
	}
	return nil
}

// postJSON posts a JSON body and checks the response (status and capped
// read).
func (s *sender) postJSON(ctx context.Context, urlStr string, headers map[string]string, body any) error {
	u, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("invalid notification URL")
	}
	if err := s.validateHTTPURL(u); err != nil {
		return err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("could not construct notification request")
	}
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	resp, err := s.httpClient().Do(request)
	if err != nil {
		// A transport error may contain the full webhook URL, including credentials.
		return fmt.Errorf("notification HTTP request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("notification endpoint returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// postSlack posts a Slack incoming-webhook message.
func (s *sender) postSlack(ctx context.Context, delivery Delivery) error {
	webhookURL, err := secretValue(ctx, s.kube, s.namespace, s.transport.URL, "slack url")
	if err != nil {
		return err
	}
	text := delivery.Subject
	if delivery.Body != "" {
		text += "\n" + delivery.Body
	}
	return s.postJSON(ctx, webhookURL, s.transport.Headers, map[string]string{"text": text})
}

// postWebhook posts a generic JSON webhook.
func (s *sender) postWebhook(ctx context.Context, delivery Delivery) error {
	webhookURL, err := secretValue(ctx, s.kube, s.namespace, s.transport.URL, "webhook url")
	if err != nil {
		return err
	}
	body := map[string]any{
		"trigger": delivery.Trigger,
		"subject": delivery.Subject,
		"body":    delivery.Body,
	}
	if delivery.Workflow != nil {
		body["workflow"] = map[string]string{
			"name":      delivery.Workflow.Name,
			"namespace": delivery.Workflow.Namespace,
			"phase":     delivery.Workflow.Phase,
			"uid":       delivery.Workflow.UID,
		}
	}
	return s.postJSON(ctx, webhookURL, s.transport.Headers, body)
}

// pagerDutyEventsAPI is the default PagerDuty Events v2 endpoint.
const pagerDutyEventsAPI = "https://events.pagerduty.com/v2/enqueue"

// postPagerDuty posts a PagerDuty Events v2 event.
func (s *sender) postPagerDuty(ctx context.Context, delivery Delivery) error {
	endpoint := pagerDutyEventsAPI
	if !s.transport.URL.isZero() {
		var err error
		if endpoint, err = secretValue(ctx, s.kube, s.namespace, s.transport.URL, "pagerduty url"); err != nil {
			return err
		}
	}
	routingKey := ""
	if !s.transport.RoutingKey.isZero() {
		var err error
		if routingKey, err = secretValue(ctx, s.kube, s.namespace, s.transport.RoutingKey, "pagerduty routing key"); err != nil {
			return err
		}
	}
	if routingKey == "" {
		// A URL that already carries the routing key (Events v2 integrations
		// expose one) needs no separate key.
		routingKey = "-"
	}
	severity := s.transport.Severity
	if severity == "" {
		severity = "error"
	}
	if delivery.Severity != "" {
		severity = delivery.Severity
	}
	body := map[string]any{
		"routing_key":  routingKey,
		"event_action": "trigger",
		"dedup_key":    delivery.DedupeKey,
		"payload": map[string]any{
			"summary":  delivery.Subject,
			"source":   "argo-server",
			"severity": severity,
		},
	}
	return s.postJSON(ctx, endpoint, s.transport.Headers, body)
}

// sendSMTP sends one mail over TLS (port 465 implicit, 587 STARTTLS).
func (s *sender) sendSMTP(ctx context.Context, delivery Delivery) error {
	host := s.transport.Host
	if _, ok := s.allowHosts[strings.ToLower(host)]; !ok {
		return fmt.Errorf("notification host %q is not allowlisted by ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS", host)
	}
	port := s.transport.Port
	if port == 0 {
		port = 465
	}
	password := ""
	if !s.transport.Password.isZero() {
		var err error
		if password, err = secretValue(ctx, s.kube, s.namespace, s.transport.Password, "smtp password"); err != nil {
			return err
		}
	}
	message := buildMail(s.transport.From, s.transport.To, delivery)
	var auth smtp.Auth
	if s.transport.Username != "" {
		auth = smtp.PlainAuth("", s.transport.Username, password, host)
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(requestTimeout)
	}
	dialer := &net.Dialer{Timeout: requestTimeout, Deadline: deadline}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", addr, err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	var client *smtp.Client
	if port == 587 {
		// STARTTLS: plain SMTP first, then upgrade.
		client, err = smtp.NewClient(conn, host)
		if err != nil {
			return err
		}
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("smtp host %s does not offer STARTTLS", host)
		}
		if err := client.StartTLS(&tls.Config{ServerName: host}); err != nil {
			return err
		}
	} else {
		// Implicit TLS.
		tlsConn := tls.Client(conn, &tls.Config{ServerName: host})
		if err := tlsConn.Handshake(); err != nil {
			return err
		}
		client, err = smtp.NewClient(tlsConn, host)
		if err != nil {
			return err
		}
	}
	defer func() { _ = client.Close() }()
	if auth != nil {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("smtp authentication failed: %w", err)
			}
		}
	}
	if err := client.Mail(s.transport.From); err != nil {
		return err
	}
	for _, to := range s.transport.To {
		if err := client.Rcpt(to); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write([]byte(message)); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}

// buildMail renders a plain-text mail.
func buildMail(from string, to []string, delivery Delivery) string {
	subject := delivery.Subject
	if delivery.Workflow != nil {
		subject = fmt.Sprintf("[%s] %s", delivery.Workflow.Phase, delivery.Subject)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", strings.ReplaceAll(strings.ReplaceAll(subject, "\r", " "), "\n", " "))
	fmt.Fprintf(&b, "Content-Type: text/plain; charset=utf-8\r\n\r\n")
	b.WriteString(delivery.Subject)
	b.WriteString("\r\n")
	if delivery.Body != "" {
		b.WriteString(strings.ReplaceAll(delivery.Body, "\n", "\r\n"))
		b.WriteString("\r\n")
	}
	return b.String()
}

// stubEventObject is the Kubernetes object a runner-health audit event is
// recorded against (the runner record carries only names, which is enough
// for an Event's involved object).
func stubEventObject(namespace, name, kind string) *v1.ObjectReference {
	return &v1.ObjectReference{Kind: kind, Name: name, Namespace: namespace, APIVersion: "v1"}
}
