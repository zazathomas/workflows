import {TextEncoder} from 'util';

import {queryParams} from './utils';

global.TextEncoder = TextEncoder;

describe('workflow query parameters', () => {
    it('requests an accurate remaining count when scanning all pages', () => {
        expect(queryParams({pagination: {limit: 200, includeRemainingItemCount: true}})).toEqual([
            'listOptions.fieldSelector=ext.showRemainingItemCount=true',
            'listOptions.limit=200'
        ]);
    });

    it('encodes UTF-8 substring filters alongside server pagination', () => {
        expect(
            queryParams({
                nameTitleContains: ' café,=! ',
                labelContains: ' Audit=Team ',
                pagination: {limit: 5, offset: '5'}
            })
        ).toEqual(['listOptions.fieldSelector=ext.nameTitleContains=636166c3a92c3d21,ext.labelContains=41756469743d5465616d', 'listOptions.continue=5', 'listOptions.limit=5']);
    });

    it('omits whitespace-only substring filters', () => {
        expect(queryParams({nameTitleContains: '  ', labelContains: '\t'})).toEqual([]);
    });

    it('filters archived workflows server-side', () => {
        expect(queryParams({archiveFilter: 'archived'})).toEqual(['listOptions.labelSelector=workflows.argoproj.io/workflow-archiving-status in (Archived,Persisted)']);
    });

    it('filters live workflows server-side while retaining workflows without an archive label', () => {
        expect(queryParams({archiveFilter: 'live'})).toEqual(['listOptions.labelSelector=workflows.argoproj.io/workflow-archiving-status notin (Archived,Persisted)']);
    });
});
