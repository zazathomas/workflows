import {queryParams} from './utils';

describe('workflow query parameters', () => {
    it('requests an accurate remaining count when scanning all pages', () => {
        expect(queryParams({pagination: {limit: 200, includeRemainingItemCount: true}})).toEqual([
            'listOptions.fieldSelector=ext.showRemainingItemCount=true',
            'listOptions.limit=200'
        ]);
    });

    it('filters archived workflows server-side', () => {
        expect(queryParams({archiveFilter: 'archived'})).toEqual(['listOptions.labelSelector=workflows.argoproj.io/workflow-archiving-status in (Archived,Persisted)']);
    });

    it('filters live workflows server-side while retaining workflows without an archive label', () => {
        expect(queryParams({archiveFilter: 'live'})).toEqual(['listOptions.labelSelector=workflows.argoproj.io/workflow-archiving-status notin (Archived,Persisted)']);
    });
});
