package broker

import (
	"bytes"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	argo "github.com/argoproj/argo-workflows/v4/pkg/plugins/executor"
	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

const PluginPath = "/api/v1/template.execute"

type Plugin struct {
	client          *http.Client
	target          string
	brokerToken     string
	argoTokenFile   string
	namespace, pool string
}

func NewPlugin(brokerURL, token, argoTokenFile, namespace, pool string, trustedCA ...string) (*Plugin, error) {
	u, err := url.Parse(brokerURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || !validCredential(token) || namespace == "" || pool == "" || argoTokenFile == "" {
		return nil, errors.New("plugin requires an HTTPS broker origin, token, namespace and pool")
	}
	u.Path = SubmitPath
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if len(trustedCA) > 0 && trustedCA[0] != "" {
		roots, err := x509.SystemCertPool()
		if err != nil || !roots.AppendCertsFromPEM([]byte(trustedCA[0])) {
			return nil, errors.New("invalid broker CA certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &Plugin{client: &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, target: u.String(), brokerToken: token, argoTokenFile: argoTokenFile, namespace: namespace, pool: pool}, nil
}

func (p *Plugin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != PluginPath {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	token, err := os.ReadFile(p.argoTokenFile)
	if err != nil || len(bytes.TrimSpace(token)) == 0 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), append([]byte("Bearer "), bytes.TrimSpace(token)...)) != 1 {
		http.Error(w, "forbidden", 403)
		return
	}
	var args argo.ExecuteTemplateArgs
	// The upstream payload may gain unrelated fields, so decode it permissively.
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequest))
	if d.Decode(&args) != nil || d.Decode(new(any)) != io.EOF || args.Template == nil || args.Workflow == nil {
		http.Error(w, "invalid execute request", 400)
		return
	}
	if args.Template.Plugin == nil {
		reply(w, 200, argo.ExecuteTemplateReply{})
		return
	}
	var plugins map[string]json.RawMessage
	if json.Unmarshal(args.Template.Plugin.Object.Value, &plugins) != nil || plugins[api.PluginKey] == nil {
		reply(w, 200, argo.ExecuteTemplateReply{})
		return
	}
	in, err := p.submission(args, plugins[api.PluginKey])
	if err != nil {
		pluginError(w, err.Error())
		return
	}
	raw, err := json.Marshal(in)
	if err != nil {
		pluginError(w, "could not encode remote step")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, p.target, bytes.NewReader(raw))
	if err != nil {
		pluginError(w, "could not construct broker request")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.brokerToken)
	res, err := p.client.Do(req)
	if err != nil {
		pluginWait(w, "broker temporarily unavailable")
		return
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case 429, 500, 502, 503, 504:
		pluginWait(w, "broker temporarily unavailable")
		return
	case 200:
	default:
		pluginError(w, "broker rejected the remote step")
		return
	}
	var out outcome
	if err := json.NewDecoder(io.LimitReader(res.Body, maxRequest)).Decode(&out); err != nil {
		pluginError(w, "invalid broker response")
		return
	}
	if out.Result == nil {
		pluginWait(w, "waiting for the remote runner")
		return
	}
	node := wfv1.NodeResult{Phase: wfv1.NodePhase(out.Result.Phase), Message: out.Result.Message}
	if node.Phase == wfv1.NodeSucceeded {
		outputs := &wfv1.Outputs{}
		for _, item := range out.Result.OutputParameters {
			outputs.Parameters = append(outputs.Parameters, wfv1.Parameter{Name: item.Name, Value: wfv1.AnyStringPtr(item.Value)})
		}
		for _, a := range in.Task.Outputs.Artifacts {
			if data, ok := out.Artifacts[a.Name]; ok {
				outputs.Artifacts = append(outputs.Artifacts, wfv1.Artifact{Name: a.Name, ArtifactLocation: wfv1.ArtifactLocation{Raw: &wfv1.RawArtifact{Data: string(data)}}})
			}
		}
		node.Outputs = outputs
	}
	reply(w, 200, argo.ExecuteTemplateReply{Node: &node})
}

func (p *Plugin) submission(args argo.ExecuteTemplateArgs, raw []byte) (submission, error) {
	var cfg struct {
		api.RunnerTemplate
		Node  string `json:"node"`
		Retry string `json:"retry,omitempty"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&cfg) != nil || dec.Decode(new(any)) != io.EOF {
		return submission{}, errors.New("invalid runner plugin parameters")
	}
	if err := cfg.Validate(); err != nil {
		return submission{}, errors.New("invalid runner template")
	}
	if cfg.Pool != p.pool || args.Workflow.ObjectMeta.Namespace != p.namespace || !api.IsDigestPinned(cfg.Image) || cfg.Node == "" || strings.Contains(cfg.Node, "{{") {
		return submission{}, errors.New("runner pool, namespace, digest or node identity is invalid")
	}
	for _, env := range cfg.Env {
		if env.SecretKeyRef != nil {
			return submission{}, errors.New("broker cannot resolve Kubernetes Secret references")
		}
	}
	retry := 0
	if cfg.Retry != "" {
		parsed, err := strconv.Atoi(cfg.Retry)
		if err != nil || parsed < 0 || parsed > 1000 {
			return submission{}, errors.New("invalid runner retry index")
		}
		retry = parsed
	}
	timeout, err := cfg.TimeoutDuration()
	if err != nil {
		return submission{}, errors.New("invalid runner timeout")
	}
	if timeout == 0 {
		timeout = 30 * time.Minute
	}
	if timeout < time.Second || timeout > time.Hour {
		return submission{}, errors.New("runner timeout must be between 1 second and 1 hour")
	}
	in := submission{Workflow: api.WorkflowRef{UID: args.Workflow.ObjectMeta.UID, Name: args.Workflow.ObjectMeta.Name, Namespace: args.Workflow.ObjectMeta.Namespace}, Node: cfg.Node, Retry: retry, TimeoutSeconds: int((timeout + time.Second - 1) / time.Second), Capabilities: cfg.RunsOn, Inputs: map[string][]byte{}, Task: api.JobTemplate{Image: cfg.Image, Command: cfg.Command, Args: cfg.Args, Env: cfg.Env, Resources: cfg.Resources, Inputs: api.ExtractInputs(args.Template), Outputs: api.ExtractOutputs(args.Template)}}
	for _, a := range args.Template.Inputs.Artifacts {
		if a.Raw == nil {
			return submission{}, errors.New("only inline raw inputs are supported")
		}
		in.Inputs[a.Name] = []byte(a.Raw.Data)
	}
	return in, nil
}

func pluginError(w http.ResponseWriter, message string) {
	reply(w, 200, argo.ExecuteTemplateReply{Node: &wfv1.NodeResult{Phase: wfv1.NodeError, Message: message}})
}
func pluginWait(w http.ResponseWriter, message string) {
	reply(w, 200, argo.ExecuteTemplateReply{Node: &wfv1.NodeResult{Phase: wfv1.NodeRunning, Message: message}, Requeue: &metav1.Duration{Duration: 5 * time.Second}})
}
