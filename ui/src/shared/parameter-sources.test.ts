import {interpolateParameterSource, PARAMETER_SOURCES_ANNOTATION, parseParameterSources} from './parameter-sources';

describe('parameter sources', () => {
    it('parses valid template annotations', () => {
        expect(
            parseParameterSources({
                [PARAMETER_SOURCES_ANNOTATION]: JSON.stringify({
                    repository: {
                        url: 'https://api.github.com/repos?q={{organization}}',
                        itemsPath: '$.items',
                        labelPath: 'name',
                        valuePath: 'full_name'
                    }
                })
            })
        ).toEqual({
            repository: {
                url: 'https://api.github.com/repos?q={{organization}}',
                itemsPath: '$.items',
                labelPath: 'name',
                valuePath: 'full_name'
            }
        });
    });

    it('parses ConfigMap sources and requires exactly one source type', () => {
        expect(
            parseParameterSources({
                [PARAMETER_SOURCES_ANNOTATION]: JSON.stringify({
                    environment: {configMap: {name: 'catalog', key: 'environments', namespace: 'shared'}, itemsPath: 'items', labelPath: 'name', valuePath: 'id'},
                    invalid: {url: 'https://example.test', configMap: {name: 'catalog', key: 'data'}},
                    incomplete: {configMap: {name: 'catalog'}}
                })
            })
        ).toEqual({
            environment: {configMap: {name: 'catalog', key: 'environments', namespace: 'shared'}, itemsPath: 'items', labelPath: 'name', valuePath: 'id'}
        });
    });

    it('ignores invalid annotations', () => {
        expect(parseParameterSources({[PARAMETER_SOURCES_ANNOTATION]: '{invalid'})).toEqual({});
        expect(parseParameterSources()).toEqual({});
    });

    it('interpolates dependent values safely', () => {
        expect(interpolateParameterSource('https://example.test/repos/{{organization}}/${repo}', {organization: 'argo workflows', repo: 'argo/cd'})).toBe(
            'https://example.test/repos/argo%20workflows/argo%2Fcd'
        );
    });
});
