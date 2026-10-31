import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import * as React from 'react';

import {DataLoaderDropdown} from './data-loader-dropdown';

describe('DataLoaderDropdown', () => {
    it('reports a loading error and retries', async () => {
        const load = jest.fn().mockRejectedValueOnce(new Error('forbidden')).mockResolvedValueOnce(['alpha']);
        render(<DataLoaderDropdown ariaLabel='Job' load={load} onChange={jest.fn()} />);
        expect(screen.getByText('Loading options…')).toBeInTheDocument();
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load options');
        fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
        await waitFor(() => expect(screen.getByRole('combobox', {name: 'Job'})).toBeInTheDocument());
        fireEvent.focus(screen.getByRole('combobox', {name: 'Job'}));
        expect(screen.getByRole('option', {name: 'alpha'})).toBeInTheDocument();
        expect(load).toHaveBeenCalledTimes(2);
    });
});
