import {fireEvent, render, screen} from '@testing-library/react';
import * as React from 'react';

import {SearchableSelect} from './searchable-select';

describe('SearchableSelect', () => {
    it('filters options and selects only an explicitly chosen option', () => {
        const onChange = jest.fn();
        render(<SearchableSelect ariaLabel='Job' options={['alpha', 'beta']} onChange={onChange} />);
        const input = screen.getByRole('combobox', {name: 'Job'});
        fireEvent.focus(input);
        fireEvent.change(input, {target: {value: 'BETA'}});
        expect(screen.getByRole('option', {name: 'beta'})).toBeInTheDocument();
        expect(screen.queryByRole('option', {name: 'alpha'})).not.toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.keyDown(input, {key: 'ArrowDown'});
        fireEvent.keyDown(input, {key: 'Enter'});
        expect(onChange).toHaveBeenCalledWith({value: 'beta', title: 'beta'});
    });

    it('does not accept arbitrary text and restores the selection on blur or Escape', () => {
        const onChange = jest.fn();
        render(<SearchableSelect ariaLabel='Job' value='alpha' options={['alpha', 'beta']} onChange={onChange} />);
        const input = screen.getByRole('combobox', {name: 'Job'});
        fireEvent.focus(input);
        fireEvent.change(input, {target: {value: 'invented'}});
        expect(screen.getByText('No matching loaded options')).toBeInTheDocument();
        fireEvent.keyDown(input, {key: 'Enter'});
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.blur(input);
        expect(input).toHaveValue('alpha');
        fireEvent.focus(input);
        fireEvent.change(input, {target: {value: 'beta'}});
        fireEvent.keyDown(input, {key: 'Escape'});
        expect(input).toHaveValue('alpha');
        expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows an unavailable existing value without making it selectable', () => {
        const onChange = jest.fn();
        render(<SearchableSelect ariaLabel='Job' value='missing' options={['alpha']} onChange={onChange} allowClear />);
        const input = screen.getByRole('combobox', {name: 'Job'});
        expect(input).toHaveValue('missing (not in available options)');
        fireEvent.focus(input);
        expect(screen.queryByRole('option', {name: /missing/})).not.toBeInTheDocument();
        fireEvent.blur(input);
        fireEvent.click(screen.getByRole('button', {name: 'Clear Job'}));
        expect(onChange).toHaveBeenCalledWith({value: '', title: ''});
    });
});
