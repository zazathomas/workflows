import requests from './requests';

// Approval decisions (docs/approvals.md). The endpoint authorises with the
// caller's dedicated Kubernetes action grant plus the Job's approver scope.

export interface ApprovalDecisionRequest {
    decision: 'approve' | 'reject';
    comment?: string;
    workflowUID: string;
    startedAt: string;
}

export const ApprovalsService = {
    // decide records the decision (approver, comment, time) and applies it:
    // approve resumes the step, reject fails only that step (onExit handlers
    // and later steps still run).
    decide(namespace: string, workflowName: string, nodeId: string, request: ApprovalDecisionRequest): Promise<unknown> {
        return requests
            .post(`api/v1/extensions/approvals/${encodeURIComponent(namespace)}/${encodeURIComponent(workflowName)}/${encodeURIComponent(nodeId)}`)
            .set('Content-Type', 'application/json')
            .send(request)
            .then(res => res.body);
    }
};
