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

test('explains the sorting limitation without naming a resource', () => {
    const onChange = jest.fn();
    const paged = render(<PaginationPanel pagination={{limit: 20, offset: 'next'}} onChange={onChange} numRecords={20} />);
    expect(paged.container).toHaveTextContent('Results cannot be globally sorted when paginated');
    expect(paged.container).not.toHaveTextContent('Workflows');

    // a list whose records fit on one page makes no claim about sorting
    const singlePage = render(<PaginationPanel pagination={{limit: 20}} onChange={onChange} numRecords={2} />);
    expect(singlePage.container).not.toHaveTextContent('globally sorted');
});
