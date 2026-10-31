export const PARAMETER_SOURCES_ANNOTATION = 'workflows.argoproj.io/parameter-sources';

export interface ParameterSourceSecret {
    namespace?: string;
    name: string;
    key: string;
    header: string;
}

export interface ParameterSourceConfigMap {
    name: string;
    key: string;
    namespace?: string;
}

export interface ParameterSource {
    url?: string;
    configMap?: ParameterSourceConfigMap;
    itemsPath?: string;
    labelPath?: string;
    valuePath?: string;
    dependsOn?: string[];
    secret?: ParameterSourceSecret;
}

export type ParameterSources = Record<string, ParameterSource>;

export function parseParameterSources(annotations?: Record<string, string>): ParameterSources {
    const value = annotations?.[PARAMETER_SOURCES_ANNOTATION];
    if (!value) {
        return {};
    }

    try {
        const parsed = JSON.parse(value) as ParameterSources;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.entries(parsed).reduce<ParameterSources>((sources, [name, source]) => {
            const hasURL = source && typeof source.url === 'string';
            const hasConfigMap = source?.configMap && typeof source.configMap.name === 'string' && typeof source.configMap.key === 'string';
            if (source && hasURL !== !!hasConfigMap) {
                sources[name] = source;
            }
            return sources;
        }, {});
    } catch {
        return {};
    }
}

export function interpolateParameterSource(value: string, parameters: Record<string, string>): string {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}|\$\{\s*([\w.-]+)\s*\}/g, (_match, moustacheName: string, dollarName: string) => {
        const name = moustacheName || dollarName;
        return encodeURIComponent(parameters[name] || '');
    });
}
