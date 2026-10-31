import {fireEvent, render, screen} from '@testing-library/react';
import * as React from 'react';

import {NamespaceFilter} from './namespace-filter';

describe('NamespaceFilter', () => {
    beforeEach(() => localStorage.clear());

    it('shows the managed namespace without an input', () => {
        localStorage.setItem('managedNamespace', 'managed');
        render(<NamespaceFilter value='managed' onChange={jest.fn()} />);
        expect(screen.getByText('managed')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('accepts a typed namespace even when it is not suggested', () => {
        const onChange = jest.fn();
        render(<NamespaceFilter value='current' extraNamespaces={['loaded']} onChange={onChange} />);
        const input = screen.getByRole('combobox', {name: 'Namespace'});
        expect(screen.getByText('Suggestions come from loaded results and recently entered namespaces.')).toBeInTheDocument();
        fireEvent.change(input, {target: {value: 'another-team'}});
        fireEvent.keyUp(input, {key: 'Enter', keyCode: 13});
        expect(onChange).toHaveBeenCalledWith('another-team');
        expect(localStorage.getItem('ns_inputs')).toContain('another-team');
    });

    it('clears the namespace filter', () => {
        const onChange = jest.fn();
        render(<NamespaceFilter value='current' onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', {name: 'Clear namespace filter'}));
        expect(onChange).toHaveBeenCalledWith('');
    });
});
