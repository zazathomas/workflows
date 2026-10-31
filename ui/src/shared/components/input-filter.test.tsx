import {act, fireEvent, render} from '@testing-library/react';
import {Autocomplete} from 'argo-ui/src/components/autocomplete/autocomplete';
import React from 'react';

import {InputFilter} from './input-filter';

jest.mock('argo-ui/src/components/autocomplete/autocomplete', () => ({
    Autocomplete: jest.fn(() => null)
}));

const lastProps = () => {
    const mock = Autocomplete as unknown as jest.Mock;
    const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
    return lastCall[0];
};

const lastItems = (): string[] => lastProps().items as string[];

describe('InputFilter', () => {
    beforeEach(() => {
        (Autocomplete as unknown as jest.Mock).mockClear();
        localStorage.clear();
    });

    it('passes only the localStorage cache when extraSuggestions is undefined', () => {
        localStorage.setItem('ns_inputs', 'argo,kube-system');
        render(<InputFilter value='' name='ns' onChange={() => undefined} />);
        expect(lastItems()).toEqual(['argo', 'kube-system']);
    });

    it('passes extraSuggestions ahead of the localStorage cache and dedups overlaps', () => {
        localStorage.setItem('ns_inputs', 'argo,kube-system');
        render(<InputFilter value='' name='ns' onChange={() => undefined} extraSuggestions={['prod', 'argo', 'staging']} />);
        expect(lastItems()).toEqual(['prod', 'argo', 'staging', 'kube-system']);
    });

    it('handles empty localStorage and empty extraSuggestions', () => {
        render(<InputFilter value='' name='ns' onChange={() => undefined} extraSuggestions={[]} />);
        expect(lastItems()).toEqual([]);
    });

    it('renders a native accessible clear button', () => {
        const onChange = jest.fn();
        const {getByRole} = render(<InputFilter value='argo' name='ns' onChange={onChange} />);
        const clearButton = getByRole('button', {name: 'Clear filter'});

        fireEvent.click(clearButton);

        expect(onChange).toHaveBeenCalledWith('');
        expect(clearButton).toHaveAttribute('type', 'button');
    });

    it('applies typed values after the configured delay', () => {
        jest.useFakeTimers();
        const onChange = jest.fn();
        render(<InputFilter value='' name='workflow-name' onChange={onChange} changeDelay={300} />);

        act(() => lastProps().onChange(null, 'running'));
        expect(onChange).not.toHaveBeenCalled();

        act(() => jest.advanceTimersByTime(300));
        expect(onChange).toHaveBeenCalledWith('running');
        jest.useRealTimers();
    });

    it('keeps the displayed value synchronized with its prop', () => {
        const {rerender} = render(<InputFilter value='running' name='workflow-name' onChange={() => undefined} />);
        expect(lastProps().value).toBe('running');

        rerender(<InputFilter value='' name='workflow-name' onChange={() => undefined} />);
        expect(lastProps().value).toBe('');
    });
});
