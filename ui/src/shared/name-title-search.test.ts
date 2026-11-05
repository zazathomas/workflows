import {fetchAllPages, matchesLabelContains, matchesNameOrTitle, matchesWorkflowName, MAX_SEARCH_PAGES, searchPageOffset} from './name-title-search';

describe('name and title search', () => {
    it('matches resource names and title annotations without matching descriptions', () => {
        const resource = {metadata: {name: 'technical-name', annotations: {'workflows.argoproj.io/title': 'Daily Cleanup', 'workflows.argoproj.io/description': 'Extra details'}}};
        expect(matchesNameOrTitle(resource, 'TECHNICAL')).toBe(true);
        expect(matchesNameOrTitle(resource, 'cleanup')).toBe(true);
        expect(matchesNameOrTitle(resource, 'details')).toBe(false);
        expect(matchesNameOrTitle({metadata: {name: 'name'}}, 'missing')).toBe(false);
    });

    it('matches substrings in label keys and values without accepting unrelated labels', () => {
        const resource = {metadata: {labels: {'example.org/team': 'Platform'}}};
        expect(matchesLabelContains(resource, 'example.org')).toBe(true);
        expect(matchesLabelContains(resource, 'PLAT')).toBe(true);
        expect(matchesLabelContains(resource, 'missing')).toBe(false);
        expect(matchesLabelContains({metadata: {}}, 'team')).toBe(false);
    });

    it('retains the semantics of non-contains run name filters', () => {
        const resource = {metadata: {name: 'alpha-123', annotations: {'workflows.argoproj.io/title': 'Friendly title'}}};
        expect(matchesWorkflowName(resource, 'friendly', 'Contains')).toBe(true);
        expect(matchesWorkflowName(resource, 'alpha', 'Prefix')).toBe(true);
        expect(matchesWorkflowName(resource, 'alpha', 'Exact')).toBe(false);
        expect(matchesWorkflowName(resource, 'alpha-123', 'Exact')).toBe(true);
        expect(matchesWorkflowName(resource, 'other', 'NotEquals')).toBe(true);
        expect(matchesWorkflowName(resource, 'alpha-123', 'NotEquals')).toBe(false);
    });

    it('scans available server pages and keeps the first resource version', async () => {
        const load = jest
            .fn()
            .mockResolvedValueOnce({metadata: {continue: 'next', resourceVersion: '1'}, items: [1]})
            .mockResolvedValueOnce({metadata: {resourceVersion: '2'}, items: [2]});
        await expect(fetchAllPages<number>(load)).resolves.toEqual({metadata: {resourceVersion: '1', continue: undefined}, items: [1, 2], truncated: false});
        expect(load).toHaveBeenNthCalledWith(1, {limit: 200, offset: undefined});
        expect(load).toHaveBeenNthCalledWith(2, {limit: 200, offset: 'next'});
    });

    it('fails on repeated pagination tokens or failed later pages', async () => {
        const loop = jest.fn().mockResolvedValue({metadata: {continue: 'same'}, items: []});
        await expect(fetchAllPages(loop)).rejects.toThrow('repeated pagination token');
        const failed = jest
            .fn()
            .mockResolvedValueOnce({metadata: {continue: 'next'}, items: []})
            .mockRejectedValueOnce(new Error('denied'));
        await expect(fetchAllPages(failed)).rejects.toThrow('denied');
    });

    it('stops after ten pages and signals that the search is incomplete', async () => {
        const load = jest.fn().mockImplementation(async ({offset}: {offset?: string}) => ({metadata: {continue: offset ? String(Number(offset) + 1) : '1'}, items: [1]}));
        await expect(fetchAllPages(load)).resolves.toEqual({items: Array(MAX_SEARCH_PAGES).fill(1), metadata: {continue: undefined, scanTruncated: true}, truncated: true});
        expect(load).toHaveBeenCalledTimes(MAX_SEARCH_PAGES);
    });

    it('recognizes only search pagination offsets', () => {
        expect(searchPageOffset('search:20')).toBe(20);
        expect(searchPageOffset('opaque-api-token')).toBe(0);
    });
});
