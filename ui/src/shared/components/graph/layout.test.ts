import {copyLayout, graphTopologySignature} from './layout';
import {Graph} from './types';

describe('graphTopologySignature', () => {
    it('ignores label changes but changes when graph topology changes', () => {
        const first = new Graph();
        first.nodes.set('root', {label: 'Root', genre: 'Pod'});
        first.nodes.set('child', {label: 'Child', genre: 'Pod'});
        first.edges.set({v: 'root', w: 'child'}, {});

        const second = new Graph();
        second.nodes.set('root', {label: 'Updated root', genre: 'Pod'});
        second.nodes.set('child', {label: 'Updated child', genre: 'Pod'});
        second.edges.set({v: 'root', w: 'child'}, {});

        expect(graphTopologySignature(first)).toBe(graphTopologySignature(second));
        second.nodes.set('leaf', {label: 'Leaf', genre: 'Pod'});
        expect(graphTopologySignature(first)).not.toBe(graphTopologySignature(second));
    });
});

describe('copyLayout', () => {
    it('copies node and edge geometry to an updated graph', () => {
        const previous = new Graph();
        previous.nodes.set('root', {label: 'Root', genre: 'Pod', x: 10, y: 20});
        previous.nodes.set('child', {label: 'Child', genre: 'Pod', x: 30, y: 40});
        previous.edges.set(
            {v: 'root', w: 'child'},
            {
                points: [
                    {x: 10, y: 20},
                    {x: 30, y: 40}
                ]
            }
        );
        previous.width = 100;
        previous.height = 200;

        const current = new Graph();
        current.nodes.set('root', {label: 'Root', genre: 'Pod', progress: 0.5});
        current.nodes.set('child', {label: 'Child', genre: 'Pod', progress: 1});
        current.edges.set({v: 'root', w: 'child'}, {});

        copyLayout(previous, current);

        expect(current.nodes.get('root')).toEqual(expect.objectContaining({x: 10, y: 20, progress: 0.5}));
        expect(current.nodes.get('child')).toEqual(expect.objectContaining({x: 30, y: 40, progress: 1}));
        expect(Array.from(current.edges.values())[0].points).toEqual([
            {x: 10, y: 20},
            {x: 30, y: 40}
        ]);
        expect(current.width).toBe(100);
        expect(current.height).toBe(200);
    });
});
