import {createInitialState, reducer, setObjectActionCreator} from './use-editable-object';

describe('createInitialState', () => {
    test('without object', () => {
        expect(createInitialState()).toEqual({
            object: undefined,
            serialization: null,
            lang: 'yaml',
            initialSerialization: null,
            edited: false
        });
    });

    test('with object', () => {
        expect(createInitialState({a: 1})).toEqual({
            object: {a: 1},
            serialization: 'a: 1\n',
            lang: 'yaml',
            initialSerialization: 'a: 1\n',
            edited: false
        });
    });
});

describe('editing a loaded object', () => {
    const loaded = {
        metadata: {name: 'sample', namespace: 'argo', resourceVersion: '12345', uid: 'abc-123'},
        spec: {entrypoint: 'main'}
    };
    const state = createInitialState(loaded);

    test('keeps resourceVersion when a pasted manifest omits it', () => {
        const next = reducer(
            state,
            setObjectActionCreator<typeof loaded>(
                'apiVersion: argoproj.io/v1alpha1\nkind: WorkflowTemplate\nmetadata:\n  name: sample\n  namespace: argo\nspec:\n  entrypoint: other\n'
            )
        );
        expect((next.object as typeof loaded).metadata.resourceVersion).toBe('12345');
        expect((next.object as typeof loaded).metadata.uid).toBe('abc-123');
    });

    test('respects an explicit resourceVersion', () => {
        const next = reducer(state, {type: 'setObject', payload: {object: {...loaded, metadata: {...loaded.metadata, resourceVersion: '999'}}}});
        expect((next.object as typeof loaded).metadata.resourceVersion).toBe('999');
    });
});

describe('reducer', () => {
    const testState = {
        object: {a: 1},
        serialization: 'a: 1\n',
        lang: 'yaml',
        initialSerialization: 'a: 1\n',
        edited: false
    } as const;

    test('setLang unedited', () => {
        const newState = reducer(testState, {type: 'setLang', payload: 'json'});
        expect(newState).toEqual({
            object: {a: 1},
            serialization: '{\n  "a": 1\n}',
            lang: 'json',
            initialSerialization: '{\n  "a": 1\n}',
            edited: false
        });
    });

    test('setLang edited', () => {
        const newState = reducer(
            {
                ...testState,
                edited: true
            },
            {type: 'setLang', payload: 'json'}
        );
        expect(newState).toEqual({
            object: {a: 1},
            serialization: '{\n  "a": 1\n}',
            lang: 'json',
            initialSerialization: 'a: 1\n',
            edited: true
        });
    });

    test('setObject with object and string', () => {
        const newState = reducer(testState, {type: 'setObject', payload: {object: {a: 2}, serialization: 'a: 2'}});
        expect(newState).toEqual({
            object: {a: 2},
            serialization: 'a: 2',
            lang: 'yaml',
            initialSerialization: 'a: 1\n',
            edited: true
        });
    });

    test('setObject with only object', () => {
        const newState = reducer(testState, {type: 'setObject', payload: {object: {a: 2}}});
        expect(newState).toEqual({
            object: {a: 2},
            serialization: 'a: 2\n',
            lang: 'yaml',
            initialSerialization: 'a: 1\n',
            edited: true
        });
    });

    test('resetObject with object', () => {
        const newState = reducer(testState, {type: 'resetObject', payload: {a: 2}});
        expect(newState).toEqual({
            object: {a: 2},
            serialization: 'a: 2\n',
            lang: 'yaml',
            initialSerialization: 'a: 2\n',
            edited: false
        });
    });
});

describe('setObjectActionCreator', () => {
    test('with object', () => {
        expect(setObjectActionCreator({a: 2})).toEqual({
            type: 'setObject',
            payload: {object: {a: 2}}
        });
    });

    test('with string', () => {
        expect(setObjectActionCreator('a: 2')).toEqual({
            type: 'setObject',
            payload: {object: {a: 2}, serialization: 'a: 2'}
        });
    });

    test("with string that can't be parsed", () => {
        expect(() => setObjectActionCreator('@')).toThrow('Plain value cannot start with reserved character @');
    });
});
