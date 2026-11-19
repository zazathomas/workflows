import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import * as React from 'react';
import {MemoryRouter} from 'react-router-dom';

import {Context} from '../shared/context';
import {services} from '../shared/services';
import {Environment} from './environment';

const listing = {
    namespace: 'argo',
    configMaps: [
        {
            kind: 'ConfigMap' as const,
            name: 'catalog',
            createdAt: '2024-01-01T00:00:00Z',
            keys: [
                {name: 'regions', size: 12},
                {name: 'teams', size: 8}
            ]
        }
    ],
    secrets: [
        {
            kind: 'Secret' as const,
            name: 'registry',
            type: 'kubernetes.io/dockerconfigjson',
            createdAt: '2024-02-01T00:00:00Z',
            keys: [{name: 'token', size: 18}]
        }
    ]
};

const context = {navigation: {goto: jest.fn()}, popup: {confirm: jest.fn()}, notifications: {}, history: {}} as any;

function renderPage() {
    return render(
        <Context.Provider value={context}>
            <MemoryRouter>
                <Environment
                    match={{params: {namespace: 'argo'}, isExact: true, path: '/environment/argo', url: '/environment/argo'}}
                    location={{pathname: '/environment/argo', search: '', hash: '', state: undefined}}
                    history={{push: jest.fn()} as any}
                />
            </MemoryRouter>
        </Context.Provider>
    );
}

describe('Environment', () => {
    beforeEach(() => localStorage.clear());

    afterEach(() => jest.restoreAllMocks());

    it('lists metadata and fetches keys only on demand', async () => {
        jest.spyOn(services.environment, 'metadata').mockResolvedValue({...listing, configMaps: [{name: 'catalog', kind: 'ConfigMap'}]} as any);
        const details = jest.spyOn(services.environment, 'details').mockResolvedValue(listing.configMaps[0] as any);
        jest.spyOn(services.info, 'collectEvent').mockImplementation(() => undefined);

        renderPage();

        expect(await screen.findByText('catalog')).toBeInTheDocument();
        expect(screen.getByText('registry')).toBeInTheDocument();
        expect(screen.queryByText('regions')).not.toBeInTheDocument();
        expect(details).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', {name: 'Show keys for catalog'}));
        expect(await screen.findByText('regions')).toBeInTheDocument();
        expect(details).toHaveBeenCalledWith('argo', 'ConfigMap', 'catalog');
        expect(screen.getByText('kubernetes.io/dockerconfigjson')).toBeInTheDocument();
        expect(screen.getByText(/Values are masked/)).toBeInTheDocument();
        expect(services.environment.metadata).toHaveBeenCalledWith('argo');
    });

    it('filters resources and their keys', async () => {
        jest.spyOn(services.environment, 'metadata').mockResolvedValue(listing as any);
        jest.spyOn(services.info, 'collectEvent').mockImplementation(() => undefined);

        renderPage();
        await screen.findByText('catalog');

        fireEvent.change(screen.getByLabelText('Filter'), {target: {value: 'token'}});
        await waitFor(() => expect(screen.queryByText('catalog')).not.toBeInTheDocument());
        expect(screen.getByText('registry')).toBeInTheDocument();
    });

    it('surfaces per-kind permission errors', async () => {
        jest.spyOn(services.environment, 'metadata').mockResolvedValue({...listing, secrets: [], errors: ['reading Secrets is not permitted']} as any);
        jest.spyOn(services.info, 'collectEvent').mockImplementation(() => undefined);

        renderPage();

        expect(await screen.findByText('reading Secrets is not permitted')).toBeInTheDocument();
    });
});
