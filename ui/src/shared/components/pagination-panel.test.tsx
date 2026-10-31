import {fireEvent, render} from '@testing-library/react';
import * as React from 'react';

import {PaginationPanel} from './pagination-panel';

test('allows selecting all results even when the current page has no continuation', () => {
    const onChange = jest.fn();
    const {getByRole, queryByRole} = render(<PaginationPanel pagination={{limit: 50}} onChange={onChange} numRecords={2} />);
    expect(queryByRole('button', {name: 'Next page'})).not.toBeInTheDocument();
    fireEvent.change(getByRole('combobox', {name: 'Results per page'}), {target: {value: '0'}});
    expect(onChange).toHaveBeenCalledWith({limit: 0});
});

test('next page preserves the selected page size', () => {
    const onChange = jest.fn();
    const {getByRole} = render(<PaginationPanel pagination={{limit: 20, nextOffset: 'next'}} onChange={onChange} numRecords={20} />);
    fireEvent.click(getByRole('button', {name: 'Next page'}));
    expect(onChange).toHaveBeenCalledWith({limit: 20, offset: 'next'});
});
