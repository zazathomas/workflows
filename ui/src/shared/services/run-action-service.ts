import requests from './requests';

export const RunActionService = {
    async allowedHosts(): Promise<string[]> {
        const response = await requests.get('api/v1/extensions/run-action-policy');
        const hosts = response.body?.allowedHosts;
        if (!Array.isArray(hosts) || hosts.some(host => typeof host !== 'string')) {
            throw new Error('Invalid run action policy');
        }
        return hosts;
    }
};
