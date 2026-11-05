import {ParameterSource} from '../parameter-sources';
import requests from './requests';

export interface ParameterOption {
    label: string;
    value: string;
}

interface ParameterOptionsResponse {
    items: ParameterOption[];
}

export const ParameterOptionsService = {
    get(
        source: ParameterSource,
        parameters: Record<string, string>,
        namespace: string,
        templateKind: 'WorkflowTemplate' | 'ClusterWorkflowTemplate',
        templateName: string,
        parameterName: string,
        signal?: AbortSignal
    ): Promise<ParameterOption[]> {
        const query = new URLSearchParams({
            templateKind,
            templateName,
            parameterName,
            namespace,
            itemsPath: source.itemsPath || '',
            labelPath: source.labelPath || '',
            valuePath: source.valuePath || ''
        });
        if (source.url) {
            query.set('parameters', JSON.stringify(parameters));
        } else if (source.configMap) {
            query.set('configMapName', source.configMap.name);
            query.set('configMapKey', source.configMap.key);
            if (source.configMap.namespace) {
                query.set('configMapNamespace', source.configMap.namespace);
            }
        }
        if (source.secret) {
            query.set('secretNamespace', source.secret.namespace || namespace || '');
            query.set('secretName', source.secret.name);
            query.set('secretKey', source.secret.key);
            query.set('header', source.secret.header);
        }
        const request = requests.get(`api/v1/extensions/parameter-options?${query.toString()}`);
        const abort = () => request.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, {once: true});
        return request.then(res => (res.body as ParameterOptionsResponse).items || []).finally(() => signal?.removeEventListener('abort', abort));
    }
};
