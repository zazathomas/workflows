package notify

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/uuid"

	"github.com/argoproj/argo-workflows/v4/util/logging"
)

const (
	outboxPrefix = "argo-notification-"
	outboxState  = "platform.argoproj.io/notification-state"
	outboxData   = "delivery.json"
	queued       = "queued"
	sent         = "sent"
	dead         = "dead-letter"
	maxAttempts  = 6
	leasePeriod  = 45 * time.Second
)

type deliveryIntent struct {
	Destination string    `json:"destination"`
	Revision    string    `json:"destinationRevision"`
	Delivery    Delivery  `json:"delivery"`
	Attempts    int       `json:"attempts"`
	Next        time.Time `json:"nextAttempt,omitempty"`
	Lease       time.Time `json:"leaseUntil,omitempty"`
	Outcome     string    `json:"outcome,omitempty"`
}

func hashBytes(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func transportRevision(transport Transport) string {
	raw, _ := json.Marshal(transport)
	return hashBytes(raw)
}

func deliveryName(key, destination string) string {
	return outboxPrefix + hashBytes([]byte(key+"\x00"+destination))
}

// enqueue persists one intent per destination. Secrets, URLs, and arbitrary
// workflow status text stay out of the outbox. The destination is resolved
// again at send time and must still match its original configuration.
func (c *Controller) enqueue(ctx context.Context, namespace, name string, transport Transport, delivery Delivery) (string, error) {
	if delivery.DedupeKey == "" {
		delivery.DedupeKey = "test/" + string(uuid.NewUUID())
	}
	intent := deliveryIntent{Destination: name, Revision: transportRevision(transport), Delivery: delivery}
	raw, err := json.Marshal(intent)
	if err != nil {
		return "", err
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: deliveryName(delivery.DedupeKey, name), Labels: map[string]string{outboxState: queued}},
		Data:       map[string]string{outboxData: string(raw)},
	}
	if c.instance != nil {
		c.instance.Label(cm)
	}
	_, err = c.kube.CoreV1().ConfigMaps(namespace).Create(ctx, cm, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return cm.Name, nil
	}
	return cm.Name, err
}

func (c *Controller) runOutbox(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		c.drain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) drain(ctx context.Context) {
	maps := c.kube.CoreV1().ConfigMaps(c.managedNamespace)
	opts := metav1.ListOptions{LabelSelector: outboxState + "=" + queued, Limit: 64}
	if c.instance != nil {
		c.instance.With(&opts)
	}
	var count int
	var oldestAge float64
	for ctx.Err() == nil {
		page, err := maps.List(ctx, opts)
		if err != nil {
			c.log.WithError(err).Warn(ctx, "could not list queued notifications")
			return
		}
		now := c.now()
		for _, cm := range page.Items {
			if cm.Labels[outboxState] == queued {
				count++
				if !cm.CreationTimestamp.IsZero() {
					oldestAge = max(oldestAge, now.Sub(cm.CreationTimestamp.Time).Seconds())
				}
			}
		}
		// At most four concurrent network calls across the page.
		var workers sync.WaitGroup
		for lane := range 4 {
			workers.Go(func() {
				for i := lane; i < len(page.Items) && ctx.Err() == nil; i += 4 {
					if err := c.deliverIntent(ctx, &page.Items[i]); err != nil && !apierrors.IsConflict(err) && !apierrors.IsNotFound(err) {
						c.log.WithError(err).WithField("record", page.Items[i].Name).Warn(ctx, "notification outbox reconciliation failed")
					}
				}
			})
		}
		workers.Wait()
		if page.Continue == "" {
			if c.instruments != nil && c.instruments.NotifyPending != nil && c.instruments.NotifyOldestAge != nil {
				c.instruments.NotifyPending.Set(float64(count))
				c.instruments.NotifyOldestAge.Set(oldestAge)
			}
			return
		}
		opts.Continue = page.Continue
	}
}

func (c *Controller) deliverIntent(ctx context.Context, cm *corev1.ConfigMap) error {
	if cm.Labels[outboxState] != queued || !strings.HasPrefix(cm.Name, outboxPrefix) || (c.instance != nil && c.instance.Validate(cm) != nil) {
		return nil
	}
	var item deliveryIntent
	if json.Unmarshal([]byte(cm.Data[outboxData]), &item) != nil || item.Delivery.DedupeKey == "" || item.Destination == "" || deliveryName(item.Delivery.DedupeKey, item.Destination) != cm.Name {
		deadRecord := cm.DeepCopy()
		deadRecord.Labels[outboxState] = dead
		_, err := c.kube.CoreV1().ConfigMaps(cm.Namespace).Update(ctx, deadRecord, metav1.UpdateOptions{})
		return err
	}
	now := c.now().UTC()
	if item.Next.After(now) || item.Lease.After(now) {
		return nil
	}
	if item.Attempts >= maxAttempts {
		item.Lease = time.Time{}
		item.Outcome = "retry limit reached"
		_, err := c.saveIntent(ctx, cm, item, dead)
		return err
	}
	item.Attempts++
	item.Lease = now.Add(leasePeriod)
	claimed, err := c.saveIntent(ctx, cm, item, queued)
	if err != nil {
		return err // updated resourceVersion is the lease fence
	}
	attempt, cancel := context.WithTimeout(ctx, 2*requestTimeout)
	defer cancel()
	state, outcome := queued, "delivery failed"
	config, err := c.kube.CoreV1().ConfigMaps(cm.Namespace).Get(attempt, ConfigMapName, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		state, outcome = dead, "destination removed"
	case err != nil:
		outcome = "destination lookup failed"
	default:
		var transport Transport
		if json.Unmarshal([]byte(config.Data[item.Destination]), &transport) != nil || transportRevision(transport) != item.Revision {
			state, outcome = dead, "destination changed"
		} else {
			result := c.deliverOne(attempt, cm.Namespace, item.Destination, transport, item.Delivery)
			c.countDelivery(item.Delivery.Trigger, transport.Type, result.Outcome)
			if result.Outcome == OutcomeDelivered {
				state, outcome = sent, OutcomeDelivered
			}
		}
	}
	item.Lease = time.Time{}
	item.Outcome = outcome
	if state == queued {
		if item.Attempts >= maxAttempts {
			state = dead
		} else {
			item.Next = c.now().UTC().Add(time.Second * time.Duration(5<<uint(item.Attempts-1)))
		}
	}
	if _, err := c.saveIntent(ctx, claimed, item, state); err != nil {
		return err
	}
	if state == dead {
		c.log.WithFields(logging.Fields{"record": cm.Name, "namespace": cm.Namespace, "outcome": outcome}).Warn(ctx, "notification dead-lettered")
	}
	return nil
}

func (c *Controller) saveIntent(ctx context.Context, cm *corev1.ConfigMap, item deliveryIntent, state string) (*corev1.ConfigMap, error) {
	raw, err := json.Marshal(item)
	if err != nil {
		return nil, fmt.Errorf("encoding delivery intent: %w", err)
	}
	update := cm.DeepCopy()
	update.Data[outboxData] = string(raw)
	update.Labels[outboxState] = state
	return c.kube.CoreV1().ConfigMaps(cm.Namespace).Update(ctx, update, metav1.UpdateOptions{})
}
