import {changeAction, changeHistory, lastChange} from './managed-fields';

describe('changeHistory', () => {
    it('returns nothing without managed fields', () => {
        expect(changeHistory({})).toEqual([]);
        expect(changeHistory({metadata: {}})).toEqual([]);
        expect(changeHistory({metadata: {managedFields: undefined}})).toEqual([]);
        expect(changeHistory({metadata: {managedFields: 'nope' as any}})).toEqual([]);
    });

    it('sorts newest first and puts entries without a time last', () => {
        const history = changeHistory({
            metadata: {
                managedFields: [
                    {manager: 'untimed', operation: 'Update'},
                    {manager: 'older', operation: 'Update', time: '2024-01-01T00:00:00Z'},
                    {manager: 'newer', operation: 'Apply', time: '2024-02-01T00:00:00Z'},
                    {manager: 'broken', operation: 'Update', time: 'not-a-date'}
                ]
            }
        });
        expect(history.map(entry => entry.manager)).toEqual(['newer', 'older', 'untimed', 'broken']);
    });
});

describe('changeAction', () => {
    it('names the managed fields operations', () => {
        expect(changeAction({operation: 'Apply'})).toBe('Applied');
        expect(changeAction({operation: 'Update'})).toBe('Updated');
        expect(changeAction({operation: 'Revert'})).toBe('Revert');
        expect(changeAction({})).toBe('Changed');
    });
});

describe('lastChange', () => {
    it('prefers the newest entry that has a time', () => {
        expect(lastChange([{manager: 'untimed'}, {manager: 'timed', time: '2024-01-01T00:00:00Z'}])?.manager).toBe('timed');
        expect(lastChange([{manager: 'untimed'}])?.manager).toBe('untimed');
        expect(lastChange([])).toBeUndefined();
    });
});
