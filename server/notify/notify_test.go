package notify

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	kubefake "k8s.io/client-go/kubernetes/fake"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wffake "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned/fake"
	"github.com/argoproj/argo-workflows/v4/server/fleetmetrics"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

// testHost extracts the hostname (without port) of a test server, matching
// the hostname the delivery allowlist checks.
func testHost(t *testing.T, server *httptest.Server) string {
	t.Helper()
	u, err := url.Parse(server.URL)
	require.NoError(t, err)
	return u.Hostname()
}

const ns = "team"

func notificationConfigMap(t *testing.T, kube *kubefake.Clientset, namespace string, data map[string]string) {
	t.Helper()
	_, err := kube.CoreV1().ConfigMaps(namespace).Create(t.Context(), &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: ConfigMapName, Namespace: namespace},
		Data:       data,
	}, metav1.CreateOptions{})
	require.NoError(t, err)
}

func workflowWithAnnotations(annotations map[string]string) *wfv1.Workflow {
	return &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "wf-1",
			Namespace:   ns,
			UID:         types.UID("uid-1"),
			Annotations: annotations,
		},
	}
}

func TestResolveWorkflowOptIn(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{
		"slack":  `{"type": "slack", "url": {"value": "https://hooks.slack.com/services/x"}}`,
		"email":  `{"type": "smtp", "host": "smtp.example.com", "from": "a@b.c", "to": ["x@y.z"]}`,
		"oncall": `{"type": "pagerduty", "routingKey": {"secret": {"name": "pd", "key": "rk"}}}`,
	})
	source := NewConfigSource(kube)

	// A workflow with the annotation opts in.
	wf := workflowWithAnnotations(map[string]string{
		common.AnnotationPrefixNotifications + "destinations": "slack",
		common.AnnotationPrefixNotifications + "triggers":     "started,succeeded,failed",
	})
	resolved, err := source.ResolveWorkflow(t.Context(), wf)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Contains(t, resolved.OptIn.Triggers, TriggerStarted)
	assert.Contains(t, resolved.OptIn.Triggers, TriggerFailed)
	assert.NotContains(t, resolved.OptIn.Triggers, TriggerSuspended)
	assert.Len(t, resolved.Destinations, 1)
	assert.Equal(t, TransportSlack, resolved.Destinations["slack"].Type)

	// Per-trigger override redirects just that trigger.
	wf = workflowWithAnnotations(map[string]string{
		common.AnnotationPrefixNotifications + "destinations": "slack",
		common.AnnotationPrefixNotifications + "triggers":     "started,failed",
		common.AnnotationPrefixNotifications + "on-failed":    "oncall,email",
	})
	resolved, err = source.ResolveWorkflow(t.Context(), wf)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, []string{"slack"}, resolved.OptIn.destinationsFor(TriggerStarted))
	assert.Equal(t, []string{"oncall", "email"}, resolved.OptIn.destinationsFor(TriggerFailed))

	// A workflow without annotations opts out (no namespace defaults).
	resolved, err = source.ResolveWorkflow(t.Context(), workflowWithAnnotations(nil))
	require.NoError(t, err)
	assert.Nil(t, resolved)
}

func TestResolveWorkflowNamespaceDefaults(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{
		"slack":    `{"type": "slack", "url": {"value": "https://hooks.slack.com/services/x"}}`,
		"defaults": `{"destinations": ["slack"], "triggers": ["failed", "error"]}`,
	})
	source := NewConfigSource(kube)

	// The namespace defaults apply when the workflow carries no annotation.
	resolved, err := source.ResolveWorkflow(t.Context(), workflowWithAnnotations(nil))
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Contains(t, resolved.OptIn.Triggers, TriggerFailed)
	assert.Contains(t, resolved.OptIn.Triggers, TriggerError)
	assert.Equal(t, []string{"slack"}, resolved.OptIn.Destinations)

	// An unknown trigger in the defaults is dropped, a known one kept.
	_, err = kube.CoreV1().ConfigMaps(ns).Update(t.Context(), &v1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: ConfigMapName, Namespace: ns},
		Data: map[string]string{
			"slack":    `{"type": "slack", "url": {"value": "https://hooks.slack.com/services/x"}}`,
			"defaults": `{"destinations": ["slack"], "triggers": ["failed", "nonsense"]}`,
		},
	}, metav1.UpdateOptions{})
	require.NoError(t, err)
	// A fresh source: the old one cached the previous ConfigMap for its TTL.
	resolved, err = NewConfigSource(kube).ResolveWorkflow(t.Context(), workflowWithAnnotations(nil))
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Len(t, resolved.OptIn.Triggers, 1)
}

func TestParseTriggersClosedSet(t *testing.T) {
	triggers, err := ParseTriggers("started, succeeded")
	require.NoError(t, err)
	assert.Equal(t, []string{"started", "succeeded"}, triggers)
	_, err = ParseTriggers("started,exploded")
	assert.Error(t, err)
}

func newTestController(t *testing.T, kube *kubefake.Clientset, allowHosts []string) *Controller {
	t.Helper()
	set := map[string]struct{}{}
	for _, host := range allowHosts {
		set[host] = struct{}{}
	}
	return NewController(ControllerConfig{
		Kube:             kube,
		WF:               wffake.NewClientset(),
		Instruments:      fleetmetrics.NewInstruments(prometheus.NewRegistry()),
		AllowHosts:       set,
		InstallNamespace: "argo",
		ManagedNamespace: "",
		Log:              logging.NewTestLogger(logging.Info, logging.Text),
		Now:              func() time.Time { return time.Now() },
		// The delivery rules (HTTPS, ports, hosts) are all still enforced;
		// only the test certificate is untrusted.
		HTTPClient: &http.Client{
			Timeout:   requestTimeout,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
		},
	})
}

func TestDeliverWebhookAllowlist(t *testing.T) {
	var received map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&received))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	host := testHost(t, server)
	kube := kubefake.NewSimpleClientset()
	c := newTestController(t, kube, []string{host})

	transport := Transport{Type: TransportWebhook, URL: Value{Value: server.URL}}
	outcomes := c.Deliver(t.Context(), ns, map[string]Transport{"hook": transport}, []string{"hook"},
		Delivery{Trigger: TriggerFailed, Subject: "run failed", Workflow: &WorkflowRef{Name: "wf-1", Namespace: ns, Phase: "Failed", UID: "uid-1"}})
	assert.Equal(t, "delivered", outcomes["hook"])
	require.NotNil(t, received)
	assert.Equal(t, "failed", received["trigger"])

	// A host outside the allowlist fails closed.
	transport = Transport{Type: TransportWebhook, URL: Value{Value: "https://hooks.example.com/x"}}
	outcomes = c.Deliver(t.Context(), ns, map[string]Transport{"hook": transport}, []string{"hook"},
		Delivery{Trigger: TriggerFailed, Subject: "run failed"})
	assert.NotEqual(t, "delivered", outcomes["hook"])
	assert.Contains(t, outcomes["hook"], "not allowlisted")

	// HTTP (not HTTPS) is refused even for an allowlisted host.
	httpURL := strings.Replace(server.URL, "https://", "http://", 1)
	transport = Transport{Type: TransportWebhook, URL: Value{Value: httpURL}}
	outcomes = c.Deliver(t.Context(), ns, map[string]Transport{"hook": transport}, []string{"hook"},
		Delivery{Trigger: TriggerFailed, Subject: "run failed"})
	assert.Contains(t, outcomes["hook"], "HTTPS")
}

func TestDeliverSecretReferencedCredentials(t *testing.T) {
	// The URL comes from a labelled Secret; an unlabelled Secret is refused.
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	host := testHost(t, server)

	kube := kubefake.NewSimpleClientset()
	_, err := kube.CoreV1().Secrets(ns).Create(t.Context(), &v1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "hook-url",
			Namespace: ns,
			Labels:    map[string]string{LabelSecretAllowed: "true"},
		},
		Data: map[string][]byte{"url": []byte(server.URL)},
	}, metav1.CreateOptions{})
	require.NoError(t, err)
	_, err = kube.CoreV1().Secrets(ns).Create(t.Context(), &v1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "unlabelled", Namespace: ns},
		Data:       map[string][]byte{"url": []byte(server.URL)},
	}, metav1.CreateOptions{})
	require.NoError(t, err)

	c := newTestController(t, kube, []string{host})
	transport := Transport{Type: TransportWebhook, URL: Value{Secret: &SecretRef{Name: "hook-url", Key: "url"}}}
	outcomes := c.Deliver(t.Context(), ns, map[string]Transport{"hook": transport}, []string{"hook"}, Delivery{Trigger: "test", Subject: "x"})
	assert.Equal(t, "delivered", outcomes["hook"])

	transport = Transport{Type: TransportWebhook, URL: Value{Secret: &SecretRef{Name: "unlabelled", Key: "url"}}}
	outcomes = c.Deliver(t.Context(), ns, map[string]Transport{"hook": transport}, []string{"hook"}, Delivery{Trigger: "test", Subject: "x"})
	assert.Contains(t, outcomes["hook"], "not labelled")
}

func TestDeliverUnknownDestination(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	c := newTestController(t, kube, nil)
	outcomes := c.Deliver(t.Context(), ns, map[string]Transport{}, []string{"missing"}, Delivery{Trigger: "test", Subject: "x"})
	assert.Contains(t, outcomes["missing"], "not defined")
}

func TestEvaluateWorkflowDedupe(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	// The destination host is not allowlisted, so the delivery fails closed
	// without any network; the dedupe logic is what is under test.
	notificationConfigMap(t, kube, ns, map[string]string{
		"slack": `{"type": "slack", "url": {"value": "https://hooks.example.invalid/x"}}`,
	})
	c := newTestController(t, kube, nil)
	wf := workflowWithAnnotations(map[string]string{
		common.AnnotationPrefixNotifications + "destinations": "slack",
		common.AnnotationPrefixNotifications + "triggers":     "succeeded",
	})
	wf.Status.Phase = wfv1.WorkflowSucceeded

	// The trigger fires once per workflow UID and phase.
	c.evaluateWorkflow(t.Context(), wf)
	require.Len(t, c.dedupe, 1)
	c.evaluateWorkflow(t.Context(), wf)
	assert.Len(t, c.dedupe, 1, "deduplicated on workflow UID plus phase")

	// A different workflow UID is a new notification.
	wf2 := wf.DeepCopy()
	wf2.UID = "uid-2"
	c.evaluateWorkflow(t.Context(), wf2)
	assert.Len(t, c.dedupe, 2)
}

func TestEvaluateWorkflowSuppressSuccess(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{
		"slack": `{"type": "slack", "url": {"value": "https://hooks.example.invalid/x"}}`,
	})
	c := newTestController(t, kube, nil)
	wf := workflowWithAnnotations(map[string]string{
		common.AnnotationPrefixNotifications + "destinations":     "slack",
		common.AnnotationPrefixNotifications + "triggers":         "succeeded,failed",
		common.AnnotationPrefixNotifications + "suppress-success": "true",
	})
	wf.Status.Phase = wfv1.WorkflowSucceeded
	// No destination fires for success (suppressed per Job), and no audit
	// events were written for it.
	c.evaluateWorkflow(t.Context(), wf)
	events, err := kube.CoreV1().Events(ns).List(t.Context(), metav1.ListOptions{})
	require.NoError(t, err)
	assert.Empty(t, events.Items, "suppressed success delivers nothing")
}

func TestAuditEventWritten(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{
		"hook": fmt.Sprintf(`{"type": "webhook", "url": {"value": "%s"}}`, server.URL),
		// A destination whose host is not allowlisted: its delivery fails
		// closed, without any network dependency.
		"blocked": `{"type": "webhook", "url": {"value": "https://blocked.example.com/x"}}`,
	})
	c := newTestController(t, kube, []string{testHost(t, server)})
	wf := workflowWithAnnotations(map[string]string{
		common.AnnotationPrefixNotifications + "destinations": "hook",
		common.AnnotationPrefixNotifications + "triggers":     "failed",
		common.AnnotationPrefixNotifications + "on-failed":    "hook,blocked",
	})
	wf.Status.Phase = wfv1.WorkflowFailed
	c.evaluateWorkflow(t.Context(), wf)

	events, err := kube.CoreV1().Events(ns).List(t.Context(), metav1.ListOptions{})
	require.NoError(t, err)
	require.Len(t, events.Items, 1, "each trigger's deliveries are audited once")
	assert.Equal(t, "NotificationDelivered", events.Items[0].Reason)
	assert.Equal(t, "Warning", events.Items[0].Type, "a failed delivery is a Warning event")
	assert.Contains(t, events.Items[0].Message, "hook: delivered")
	assert.Contains(t, events.Items[0].Message, "not allowlisted")
}

func TestResolveRunnerHealth(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, "argo", map[string]string{
		"oncall":        `{"type": "pagerduty", "routingKey": {"value": "rk"}}`,
		"runner-health": `{"destinations": ["oncall"], "offlineMinutes": 10, "queueDepthAlert": 50}`,
	})
	source := NewConfigSource(kube)
	health, destinations, err := source.ResolveRunnerHealth(t.Context(), "argo")
	require.NoError(t, err)
	require.NotNil(t, health)
	assert.Equal(t, 10, health.OfflineMinutes)
	assert.Equal(t, 50, health.QueueDepthAlert)
	assert.Equal(t, []string{"oncall"}, health.Destinations)
	assert.Len(t, destinations, 1)

	// No runner-health key: disabled.
	kube2 := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube2, "argo", map[string]string{
		"oncall": `{"type": "pagerduty", "routingKey": {"value": "rk"}}`,
	})
	health, _, err = NewConfigSource(kube2).ResolveRunnerHealth(t.Context(), "argo")
	require.NoError(t, err)
	assert.Nil(t, health)
}
