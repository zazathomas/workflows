import * as models from '../models';
import requests from './requests';
import {queryParams} from './utils';

export const ClusterWorkflowTemplateService = {
    create(template: models.ClusterWorkflowTemplate) {
        return requests
            .post(`api/v1/cluster-workflow-templates`)
            .send({template})
            .then(res => res.body as models.ClusterWorkflowTemplate);
    },

    list(labels?: string[]) {
        const query = queryParams({labels}).join('&');
        return requests
            .get(`api/v1/cluster-workflow-templates${query ? `?${query}` : ''}`)
            .then(res => res.body as models.ClusterWorkflowTemplateList)
            .then(list => list.items || []);
    },

    get(name: string) {
        return requests.get(`api/v1/cluster-workflow-templates/${name}`).then(res => res.body as models.ClusterWorkflowTemplate);
    },

    update(template: models.ClusterWorkflowTemplate, name: string) {
        return requests
            .put(`api/v1/cluster-workflow-templates/${name}`)
            .send({template})
            .then(res => res.body as models.ClusterWorkflowTemplate);
    },

    delete(name: string) {
        return requests.delete(`api/v1/cluster-workflow-templates/${name}`);
    }
};
