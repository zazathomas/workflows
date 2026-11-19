import {EnvironmentListing, EnvironmentService} from './environment-service';
import requests from './requests';

jest.mock('./requests');

describe('EnvironmentService', () => {
    it('lists the namespace through the extension API', async () => {
        const listing: EnvironmentListing = {namespace: 'argo', configMaps: [], secrets: []};
        (requests.get as jest.Mock).mockResolvedValue({body: listing});

        await expect(EnvironmentService.list('argo')).resolves.toBe(listing);
        expect(requests.get).toHaveBeenCalledWith('api/v1/extensions/environment?namespace=argo');
    });

    it('does not call the server without a namespace', async () => {
        (requests.get as jest.Mock).mockClear();
        await expect(EnvironmentService.list('')).rejects.toThrow('namespace is required');
        expect(requests.get).not.toHaveBeenCalled();
    });
});
