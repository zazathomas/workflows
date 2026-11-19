package notify

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kubefake "k8s.io/client-go/kubernetes/fake"
)

func TestOutboxSurvivesRestartAndRetries(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	kube := kubefake.NewSimpleClientset()
	transport := Transport{Type: TransportWebhook, URL: Value{Value: server.URL + "/sensitive-path"}}
	raw, err := json.Marshal(transport)
	require.NoError(t, err)
	notificationConfigMap(t, kube, ns, map[string]string{"hook": string(raw)})
	c := newTestController(t, kube, []string{testHost(t, server)})
	event := Delivery{Trigger: TriggerFailed, DedupeKey: "uid/failed"}
	name, err := c.enqueue(t.Context(), ns, "hook", transport, event)
	require.NoError(t, err)
	duplicate, err := c.enqueue(t.Context(), ns, "hook", transport, event)
	require.NoError(t, err)
	assert.Equal(t, name, duplicate)

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	worker := newTestController(t, kube, []string{testHost(t, server)})
	worker.managedNamespace = ns
	worker.now = func() time.Time { return now }
	worker.drain(t.Context())
	maps := kube.CoreV1().ConfigMaps(ns)
	cm, err := maps.Get(t.Context(), name, metav1.GetOptions{})
	require.NoError(t, err)
	assert.NotContains(t, cm.Data[outboxData], "sensitive-path")
	assert.Equal(t, queued, cm.Labels[outboxState])
	worker.drain(t.Context())
	assert.EqualValues(t, 1, attempts.Load(), "backoff still active")
	now = now.Add(time.Minute)
	worker.drain(t.Context())
	cm, err = maps.Get(t.Context(), name, metav1.GetOptions{})
	require.NoError(t, err)
	assert.Equal(t, sent, cm.Labels[outboxState])
	worker.drain(t.Context())
	assert.EqualValues(t, 2, attempts.Load())
}

func TestOutboxDeadLettersWhenDestinationChanges(t *testing.T) {
	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{"hook": `{"type":"webhook","url":{"value":"https://new.example/hook"}}`})
	c := newTestController(t, kube, []string{"old.example", "new.example"})
	c.managedNamespace = ns
	name, err := c.enqueue(t.Context(), ns, "hook", Transport{Type: TransportWebhook, URL: Value{Value: "https://old.example/hook"}}, Delivery{Trigger: TriggerFailed, DedupeKey: "uid/failed"})
	require.NoError(t, err)
	c.drain(t.Context())
	cm, err := kube.CoreV1().ConfigMaps(ns).Get(t.Context(), name, metav1.GetOptions{})
	require.NoError(t, err)
	assert.Equal(t, dead, cm.Labels[outboxState])
	assert.True(t, strings.Contains(cm.Data[outboxData], "destination changed"))
}
