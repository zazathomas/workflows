import * as React from 'react';
import {useEffect, useState} from 'react';

import {Link} from '../models';
import {services} from '../services';

import './chat-button.scss';

export function ChatButton() {
    const [link, setLink] = useState<Link>();

    useEffect(() => {
        services.info
            .getInfo()
            .then(info => info.links)
            .then(links => (links || []).concat({name: 'Get help', scope: 'chat', url: 'https://argo-workflows.readthedocs.io/en/latest/'}).filter(x => x.scope === 'chat'))
            .then(links => {
                setLink(links[0]);
            });
    }, []);

    if (!link) {
        return null;
    }

    return (
        <div className='chat-button'>
            <a href={link.url} className='argo-button argo-button--special' target='_blank' rel='noreferrer' aria-label={`${link.name} (opens in a new tab)`}>
                <i className='fas fa-comment-alt' aria-hidden='true' /> <span>{link.name}</span>
            </a>
        </div>
    );
}
