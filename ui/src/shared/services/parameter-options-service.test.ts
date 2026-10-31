import {ParameterOptionsService} from './parameter-options-service';
import requests from './requests';

jest.mock('./requests');

describe('ParameterOptionsService', () => {
    it('requests mapped options through the additive extension API', async () => {
        (requests.get as jest.Mock).mockResolvedValue({body: {items: [{label: 'Argo', value: 'argoproj/argo-workflows'}]}} as any);

        const options = await ParameterOptionsService.get(
            {
                url: 'https://api.github.com/repos?q={{organization}}',
                itemsPath: '$.items',
                labelPath: 'name',
                valuePath: 'full_name',
                secret: {
                    namespace: 'argo',
                    name: 'github-token',
                    key: 'token',
                    header: 'Authorization'
                }
            },
            {organization: 'argoproj'},
            'argo',
            'WorkflowTemplate',
            'sample',
            'repository'
        );

        expect(options).toEqual([{label: 'Argo', value: 'argoproj/argo-workflows'}]);
        expect(requests.get).toHaveBeenCalledWith(
            'api/v1/extensions/parameter-options?templateKind=WorkflowTemplate&templateName=sample&parameterName=repository&namespace=argo&itemsPath=%24.items&labelPath=name&valuePath=full_name&url=https%3A%2F%2Fapi.github.com%2Frepos%3Fq%3Dargoproj&parameters=%7B%22organization%22%3A%22argoproj%22%7D&secretNamespace=argo&secretName=github-token&secretKey=token&header=Authorization'
        );
    });

    it('requests ConfigMap options from the submitting namespace', async () => {
        (requests.get as jest.Mock).mockResolvedValue({body: {items: [{label: 'Staging', value: 'staging'}]}} as any);

        await ParameterOptionsService.get(
            {configMap: {name: 'catalog', key: 'environments', namespace: 'shared'}, itemsPath: 'items', labelPath: 'name', valuePath: 'id'},
            {},
            'argo',
            'WorkflowTemplate',
            'sample',
            'environment'
        );

        expect(requests.get).toHaveBeenCalledWith(
            'api/v1/extensions/parameter-options?templateKind=WorkflowTemplate&templateName=sample&parameterName=environment&namespace=argo&itemsPath=items&labelPath=name&valuePath=id&configMapName=catalog&configMapKey=environments&configMapNamespace=shared'
        );
    });
});
