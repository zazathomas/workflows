package parameter

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/argoproj/argo-workflows/v4/server/auth"
)

const annotationKey = "workflows.argoproj.io/parameter-sources"

var placeholder = regexp.MustCompile(`\{\{\s*([\w.-]+)\s*\}\}|\$\{\s*([\w.-]+)\s*\}`)

type sourceSpec struct {
	URL       string `json:"url"`
	ConfigMap *struct {
		Name      string `json:"name"`
		Key       string `json:"key"`
		Namespace string `json:"namespace"`
	} `json:"configMap"`
	ItemsPath string `json:"itemsPath"`
	LabelPath string `json:"labelPath"`
	ValuePath string `json:"valuePath"`
	Secret    *struct {
		Name      string `json:"name"`
		Key       string `json:"key"`
		Namespace string `json:"namespace"`
		Header    string `json:"header"`
	} `json:"secret"`
}

// authorizeSource ties every fetch to a template the caller can read. Never trust
// the client-supplied URL, ConfigMap or Secret identifiers on their own.
func (h *OptionsHandler) authorizeSource(r *http.Request) error {
	q := r.URL.Query()
	namespace, name, kind, parameter := q.Get("namespace"), q.Get("templateName"), q.Get("templateKind"), q.Get("parameterName")
	if namespace == "" || name == "" || parameter == "" {
		return errors.New("namespace, templateName and parameterName are required")
	}
	client := auth.GetWfClient(r.Context()).ArgoprojV1alpha1()
	var annotations map[string]string
	var parameters []string
	switch kind {
	case "WorkflowTemplate":
		template, err := client.WorkflowTemplates(namespace).Get(r.Context(), name, metav1.GetOptions{})
		if err != nil {
			return errors.New("template is not available to this user")
		}
		annotations = template.Annotations
		for _, p := range template.Spec.Arguments.Parameters {
			parameters = append(parameters, p.Name)
		}
	case "ClusterWorkflowTemplate":
		template, err := client.ClusterWorkflowTemplates().Get(r.Context(), name, metav1.GetOptions{})
		if err != nil {
			return errors.New("template is not available to this user")
		}
		annotations = template.Annotations
		for _, p := range template.Spec.Arguments.Parameters {
			parameters = append(parameters, p.Name)
		}
	default:
		return errors.New("invalid templateKind")
	}
	found := slices.Contains(parameters, parameter)
	if !found {
		return errors.New("parameter is not declared by the template")
	}
	var sources map[string]sourceSpec
	if err := json.Unmarshal([]byte(annotations[annotationKey]), &sources); err != nil {
		return errors.New("invalid template parameter sources")
	}
	source, ok := sources[parameter]
	if !ok || (source.URL == "") == (source.ConfigMap == nil) {
		return errors.New("parameter source is not declared by the template")
	}
	if q.Get("itemsPath") != source.ItemsPath || q.Get("labelPath") != source.LabelPath || q.Get("valuePath") != source.ValuePath {
		return errors.New("parameter mapping differs from the template")
	}
	if source.ConfigMap != nil {
		if q.Get("url") != "" || q.Get("configMapName") != source.ConfigMap.Name || q.Get("configMapKey") != source.ConfigMap.Key || q.Get("configMapNamespace") != source.ConfigMap.Namespace {
			return errors.New("ConfigMap source differs from the template")
		}
	} else {
		var values map[string]string
		if err := json.Unmarshal([]byte(q.Get("parameters")), &values); err != nil {
			return errors.New("invalid parameter values")
		}
		expectedURL := placeholder.ReplaceAllStringFunc(source.URL, func(match string) string {
			name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}"))
			if after, ok := strings.CutPrefix(match, "${"); ok {
				name = strings.TrimSuffix(after, "}")
			}
			return strings.ReplaceAll(url.QueryEscape(values[name]), "+", "%20")
		})
		if q.Get("url") != expectedURL || q.Get("configMapName") != "" {
			return errors.New("URL source differs from the template")
		}
	}
	if source.Secret == nil {
		if q.Get("secretName") != "" || q.Get("secretNamespace") != "" || q.Get("secretKey") != "" || q.Get("header") != "" {
			return errors.New("secret is not declared by the template")
		}
	} else {
		secretNamespace := source.Secret.Namespace
		if secretNamespace == "" {
			secretNamespace = namespace
		}
		if secretNamespace != namespace {
			return errors.New("cross-namespace secrets are not supported")
		}
		if q.Get("secretName") != source.Secret.Name || q.Get("secretNamespace") != secretNamespace || q.Get("secretKey") != source.Secret.Key || q.Get("header") != source.Secret.Header {
			return errors.New("secret source differs from the template")
		}
	}
	return nil
}
