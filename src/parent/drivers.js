/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { cleanUpWindow, ProxyWindow, toProxyWindow } from 'post-robot/src';
import { assertSameDomain, closeWindow, type CrossDomainWindowType } from 'cross-domain-utils/src';
import { iframe, popup, destroyElement, normalizeDimension, watchElementForClose,
    awaitFrameWindow, uniqueID } from 'belter/src';

import { CONTEXT } from '../constants';
import { getProxyObject, type ProxyObject } from '../lib';


export type ContextDriverType = {|
    openFrame? : ({ windowName : string }) => ProxyObject<HTMLIFrameElement>,
    open : ({ windowName : string, proxyFrame : ?ProxyObject<HTMLIFrameElement> }) => ZalgoPromise<CrossDomainWindowType>,
    openPrerenderFrame? : () => ProxyObject<HTMLIFrameElement>,
    openPrerender : (ProxyWindow, ?ProxyObject<HTMLIFrameElement>) => ZalgoPromise<ProxyWindow>,
    resize? : ({ width : ?number, height : ?number }) => void,
    delegate : $ReadOnlyArray<string>
|};

export const RENDER_DRIVERS : { [string] : ContextDriverType } = {};

RENDER_DRIVERS[CONTEXT.IFRAME] = {
    openFrame({ windowName } : { windowName : string }) : ProxyObject<HTMLIFrameElement> {
        return getProxyObject(iframe({
            attributes: {
                name:  windowName,
                title: this.component.name,
                ...this.component.attributes.iframe
            }
        }));
    },

    open({ proxyFrame } : { proxyFrame : ?ProxyObject<HTMLIFrameElement> }) : ZalgoPromise<CrossDomainWindowType> {
        if (!proxyFrame) {
            throw new Error(`Expected proxy frame to be passed`);
        }

        return proxyFrame.get().then(frame => {
            return awaitFrameWindow(frame).then(win => {

                const frameWatcher = watchElementForClose(frame, () => this.close());
                this.clean.register(() => frameWatcher.cancel());
                this.clean.register(() => destroyElement(frame));
                this.clean.register(() => cleanUpWindow(win));

                return win;
            });
        });
    },

    openPrerenderFrame() : ProxyObject<HTMLIFrameElement> {
        return getProxyObject(iframe({
            attributes: {
                name:  `__zoid_prerender_frame__${ this.component.name }_${ uniqueID() }__`,
                title: `prerender__${ this.component.name }`,
                ...this.component.attributes.iframe
            }
        }));
    },

    openPrerender(proxyWin : ProxyWindow, proxyPrerenderFrame : ?ProxyObject<HTMLIFrameElement>) : ZalgoPromise<ProxyWindow> {
        if (!proxyPrerenderFrame) {
            throw new Error(`Expected proxy frame to be passed`);
        }
        
        return proxyPrerenderFrame.get().then(prerenderFrame => {
            this.clean.register(() => destroyElement(prerenderFrame));

            return awaitFrameWindow(prerenderFrame).then(prerenderFrameWindow => {
                return assertSameDomain(prerenderFrameWindow);
            }).then(win => {
                return toProxyWindow(win);
            });
        });
    },

    delegate: [
        'getProxyWindow',
        'getProxyContainer',
        'renderContainer',
        'openFrame',
        'openPrerenderFrame',
        'prerender',
        'open',
        'openPrerender',
        'show',
        'hide'
    ]
};

if (__ZOID__.__POPUP_SUPPORT__) {
    RENDER_DRIVERS[CONTEXT.POPUP] = {
        open({ windowName } : { windowName : string }) : ZalgoPromise<CrossDomainWindowType> {
            return ZalgoPromise.try(() => {
                let { width, height } = this.component.dimensions;

                width = normalizeDimension(width, window.outerWidth);
                height = normalizeDimension(height, window.outerWidth);

                const win = popup('', {
                    name: windowName,
                    width,
                    height,
                    ...this.component.attributes.popup
                });

                this.clean.register(() => {
                    closeWindow(win);
                    cleanUpWindow(win);
                });

                return win;
            });
        },

        openPrerender(proxyWin : ProxyWindow) : ZalgoPromise<ProxyWindow> {
            return ZalgoPromise.try(() => {
                return proxyWin;
            });
        },

        delegate: [
            'getProxyContainer',
            'renderContainer',
            'setProxyWin',
            'show',
            'hide'
        ]
    };
}
