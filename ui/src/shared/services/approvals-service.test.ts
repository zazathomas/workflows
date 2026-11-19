import {ApprovalsService} from './approvals-service';
import requests from './requests';

jest.mock('./requests');

const attempt = {workflowUID: 'uid', startedAt: '2024-01-01T00:00:00Z'};

describe('approvals service', () => {
    test('decide posts the decision to the workflow step', async () => {
        const request = {
            set: jest.fn().mockReturnThis(),
            send: jest.fn().mockResolvedValue({body: {}})
        };
        jest.spyOn(requests, 'post').mockReturnValue(request as any);

        await ApprovalsService.decide('team', 'wf 1', 'gate-1', {...attempt, decision: 'approve', comment: 'looks good'});

        expect(requests.post).toHaveBeenCalledWith('api/v1/extensions/approvals/team/wf%201/gate-1');
        expect(request.set).toHaveBeenCalledWith('Content-Type', 'application/json');
        expect(request.send).toHaveBeenCalledWith({...attempt, decision: 'approve', comment: 'looks good'});
    });

    test('reject fails only that step', async () => {
        const request = {
            set: jest.fn().mockReturnThis(),
            send: jest.fn().mockResolvedValue({body: {}})
        };
        jest.spyOn(requests, 'post').mockReturnValue(request as any);

        await ApprovalsService.decide('team', 'wf-1', 'gate-1', {...attempt, decision: 'reject'});

        expect(request.send).toHaveBeenCalledWith({...attempt, decision: 'reject'});
    });
});
