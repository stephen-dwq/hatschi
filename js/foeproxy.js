/*
 * **************************************************************************************
 * Copyright (C) 2026 FoE-Helper team - All Rights Reserved
 * You may use, distribute and modify this code under the
 * terms of the AGPL license.
 *
 * See file LICENSE.md or go to
 * https://github.com/mainIine/foe-helfer-extension/blob/master/LICENSE.md
 * for full license details.
 *
 * **************************************************************************************
 */
if (typeof globalThis.FoEproxy == 'undefined') {
    globalThis.FoEproxy = (function () {
        globalThis.globalID = 1;
        const HASH_KEY = 'l7ObUnBjb1IuLnSeN/H6F9s+f1UEv3r4pPqhnHUsqECVrT9mXTLa+0NxOrCo9S/HWOYZ7KatZ7IRrNUYb3le2g=='; // from ForgeHX-*.js
        let firstSig = null; // first md5 hash
        let jsonHash = null; // ?h= param
        let baseURL = null; // detected base URL in form "https://xx.forgeofempires.com/game/json"
        let clientID = null;
        let contentType = "application/json";

        const requestInfoHolder = new WeakMap();
        let proxyEnabled = true;
        let xhrQueue = [];

        function getRequestData(xhr) {
            let data = requestInfoHolder.get(xhr);
            if (data != null) return data;

            data = { url: null, method: null, postData: null };
            requestInfoHolder.set(xhr, data);
            return data;
        }

        // ###########################################
        // ################# XHR-Proxy ###############
        // ###########################################

        const XHR = XMLHttpRequest.prototype,
            open = XHR.open,
            send = XHR.send,
            setRequestHeader = XHR.setRequestHeader;

        /**
         * @param {string} method
         * @param {string} url
         */
        XHR.open = function (method, url) {
            if (proxyEnabled) {
                const data = getRequestData(this);
                data.method = method;
                data.url = url;

                if (jsonHash == null && url) {
                    const match = url.match(/.*\?h=([0-9a-zA-Z_-]+)(&|$)/);
                    if (null != match) {
                        jsonHash = match[1];
                        console.log("JSON  |  " + jsonHash);
                        // Extract base URL in form "https://xx.forgeofempires.com/game/json"
                        const baseURLMatch = url.match(/(https:\/\/[^\/]+\/game\/json)/);
                        if (null != baseURLMatch) {
                            baseURL = baseURLMatch[1];
                            console.log("BASE URL  |  " + baseURL);
                        }
                    }
                }
            }
            // @ts-ignore
            return open.apply(this, arguments);
        };

        /**
         * @this {XHR}
         */
        function xhrOnLoadHandler() {
            if (!proxyEnabled) return;

            if (xhrQueue) {
                xhrQueue.push(this);
                return;
            }
            xhrOnLoadHandlerExec.call(this);
        }

        function xhrOnLoadHandlerExec() {
            const requestData = getRequestData(this);
            const url = requestData.url;
            const postData = requestData.postData;

            // handle raw request handlers
            for (let callback of FoEproxy._getProxyRaw()) {
                try {
                    callback(this, requestData);
                } catch (e) {
                    console.error(e);
                }
            }

            // handle metadata request handlers
            const metadataIndex = url.indexOf("metadata?id=");

            if (metadataIndex > -1) {
                const metaURLend = metadataIndex + "metadata?id=".length,
                    metaArray = url.substring(metaURLend).split('-', 2),
                    meta = metaArray[0];

                MainParser.MetaIds[meta] = metaArray[1];

                const metaHandler = FoEproxy._getMetaMap()[meta];

                if (metaHandler) {
                    for (let callback of metaHandler) {
                        try {
                            callback(this, postData);
                        } catch (e) {
                            console.error(e);
                        }
                    }
                }
            }

            // nur die jSON mit den Daten abfangen
            if (url.indexOf("game/json?h=") > -1) {
                let d = /** @type {FoE_NETWORK_TYPE[]} */(JSON.parse(this.responseText));

                let requestData = postData;

                try {
                    requestData = JSON.parse(new TextDecoder().decode(postData));
                    // StartUp Service als erstes behandeln
                    for (let entry of d) {
                        if (entry['requestClass'] === 'StaticDataService' && entry['requestMethod'] === 'getMetadata') {
                            FoEproxy._addToHistory(entry.requestClass + '.' + entry.requestMethod);
                            FoEproxy._proxyAction(entry.requestClass, entry.requestMethod, entry, requestData);
                        }
                    }
                    // StartUp Service als zweites behandeln
                    for (let entry of d) {
                        if (entry['requestClass'] === 'StartupService' && entry['requestMethod'] === 'getData') {
                            FoEproxy._addToHistory(entry.requestClass + '.' + entry.requestMethod);
                            FoEproxy._proxyAction(entry.requestClass, entry.requestMethod, entry, requestData);
                        }
                    }

                    for (let entry of d) {
                        if (!(entry['requestClass'] === 'StartupService' && entry['requestMethod'] === 'getData') &&
                            !(entry['requestClass'] === 'StaticDataService' && entry['requestMethod'] === 'getMetadata')) {
                            FoEproxy._addToHistory(entry.requestClass + '.' + entry.requestMethod);
                            FoEproxy._proxyAction(entry.requestClass, entry.requestMethod, entry, requestData);
                        }
                    }

                } catch (e) {
                    console.log('Can\'t parse postData: ', postData, e);
                }

            }
        }

        function xhrOnSend(data) {
            if (!proxyEnabled) return;
            if (!data) return;

            try {
                let posts = [];

                if (typeof data === 'object' && data instanceof ArrayBuffer) {
                    if (data.bytes[0] === 31 && data.bytes[1] === 139 && data.bytes[2] === 8) {
                        // gzipped, ignore
                        return
                    } else {
                        // try plaintext
                        posts = JSON.parse(new TextDecoder().decode(data));
                    }
                } else if (typeof data === 'object' && data instanceof Uint8Array) {
                    if (data[0] === 31 && data[1] === 139 && data[2] === 8) {
                        // gzipped, ignore
                        return
                    } else {
                        // try plaintext
                        posts = JSON.parse(new TextDecoder().decode(data));
                    }
                } else
                    posts = JSON.parse(data);

                if (!(posts instanceof Array)) {
                    // ignore (probably) game-unrelated request
                    return;
                }

                for (let post of posts) {
                    if (!post || !post.requestClass || !post.requestMethod || !post.requestData) return;

                    if (post.requestId) {
                        globalThis.globalID = (globalThis.globalID > post.requestId) ? globalThis.globalID : post.requestId;
                        post.requestId = globalThis.globalID++;
                    }

                    FoEproxy._proxyRequestAction(post.requestClass, post.requestMethod, post);
                }

                return JSON.stringify(posts);
            } catch (e) {
                console.log('Can\'t parse postData: ', data, e);
            }

            return data;
        }

        XHR.send = function (postData) {
            if (proxyEnabled) {
                const requestData = getRequestData(this);

                const modifiedData = xhrOnSend(postData);

                if (modifiedData !== undefined)
                    postData = modifiedData;

                this.addEventListener('load', xhrOnLoadHandler, { capture: false, passive: true });

                if (requestData.url && requestData.url.includes(jsonHash) &&
                    typeof FoeCrypto !== 'undefined' && jsonHash && HASH_KEY) {
                    const sig = FoeCrypto.generateSignature(jsonHash, HASH_KEY, postData);

                    if (globalThis.globalID == 3 && sig != firstSig) {
                        alert("FIND NEW HASH KEY");
                        throw '';
                    } else if (globalThis.globalID == 3) {
                        console.log("SAFE KEY");
                    }

                    setRequestHeader.call(this, 'Signature', sig);
                    postData = FoeCrypto.blobber(postData);
                }

                requestData.postData = postData;
            }

            // @ts-ignore
            return send.apply(this, arguments);
        };

        XHR.setRequestHeader = function (header, value) {
            if (header == "Signature") {
                if (firstSig == null) {
                    firstSig = value;
                    console.log("FIRST SIG  |  " + firstSig);
                }
                return;
            }

            if (clientID == null && getRequestData(this).url.includes("game/json?h=") && header == "Client-Identification")
                clientID = value;

            return setRequestHeader.apply(this, arguments);
        }

        // Public API für Queue-Verarbeitung
        return {
            sendRequest: function (postData, onLoad) {
                const newReq = new XMLHttpRequest();
                newReq.open("POST", baseURL + "?h=" + jsonHash);
                newReq.setRequestHeader("Client-Identification", clientID);
                newReq.setRequestHeader("Content-Type", contentType);

                newReq.onload = onLoad;

                newReq.send(FoeCrypto.blobber(postData));
            },
            _setXhrQueue: (queue) => { xhrQueue = queue; },
            _getXhrQueue: () => xhrQueue,
            _setProxyEnabled: (enabled) => { proxyEnabled = enabled; },
            _getProxyEnabled: () => proxyEnabled,
            _xhrOnLoadHandlerExec: xhrOnLoadHandlerExec
        };
    })();
    //extend FoEproxy with utility functions
    Object.assign(globalThis.FoEproxy, (function () {
        const proxyMap = {};
        const proxyRequestsMap = {};
        const proxyMetaMap = {};
        let proxyRaw = [];
        const wsHandlerMap = {};
        let wsRawHandler = [];
        let JSONhistory = [];
        let wsQueue = [];
        let proxyEnabled = true;

        const observedWebsockets = new WeakSet();
        const oldWSSend = WebSocket.prototype.send;

        // ###########################################
        // ############## Websocket-Proxy ############
        // ###########################################

        function _proxyWsAction(service, method, data) {
            const map = wsHandlerMap[service];
            if (!map) return;
            const list = map[method];
            if (!list) return;
            for (let callback of list) {
                try {
                    callback(data);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        function proxyWsAction(service, method, data) {
            _proxyWsAction(service, method, data);
            _proxyWsAction('all', method, data);
            _proxyWsAction(service, 'all', data);
            _proxyWsAction('all', 'all', data);
        }

        function wsMessageHandler(evt) {
            if (wsQueue) {
                wsQueue.push(evt);
                return;
            }
            wsMessageHandlerExec(evt);
        }

        function wsMessageHandlerExec(evt) {
            try {
                if (evt.data === 'PONG') return;
                /** @type {FoE_NETWORK_TYPE[]|FoE_NETWORK_TYPE} */
                const data = JSON.parse(evt.data);

                for (let callback of wsRawHandler) {
                    try {
                        callback(data);
                    } catch (e) {
                        console.error(e);
                    }
                }

                if (data instanceof Array) {
                    for (let entry of data) {
                        proxyWsAction(entry.requestClass, entry.requestMethod, entry);
                    }
                } else if (data.__class__ === "ServerResponse") {
                    proxyWsAction(data.requestClass, data.requestMethod, data);
                }
            } catch (e) {
                console.error(e);
            }
        }

        WebSocket.prototype.send = function (data) {
            if ("PING" != data) {
                posts = JSON.parse(data);
                if (posts.requestId == 1 || posts.requestId == 2) {
                    alert("WEBSOCKET WENT FIRST");
                    throw '';
                }
                posts.requestId = globalThis.globalID++;
                data = JSON.stringify(posts)
            }

            oldWSSend.call(this, data);
            if (proxyEnabled && !observedWebsockets.has(this)) {
                observedWebsockets.add(this);
                this.addEventListener('message', wsMessageHandler, { capture: false, passive: true });
            }
        };

        // ###########################################
        // ############### XHR-Utility ###############
        // ###########################################

        function _proxyAction(service, method, data, postData) {
            const map = proxyMap[service];
            if (!map) return;
            const list = map[method];
            if (!list) return;
            for (let callback of list) {
                try {
                    callback(data, postData);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        function proxyAction(service, method, data, postData) {
            let filteredPostData = postData.filter(r => r && r.requestId && data && data.requestId && r.requestId === data.requestId);
            _proxyAction(service, method, data, filteredPostData);
            _proxyAction('all', method, data, filteredPostData);
            _proxyAction(service, 'all', data, filteredPostData);
            _proxyAction('all', 'all', data, filteredPostData);
        }

        function _proxyRequestAction(service, method, postData) {
            const map = proxyRequestsMap[service];
            if (!map) return;
            const list = map[method];
            if (!list) return;
            for (let callback of list) {
                try {
                    callback(postData);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        function proxyRequestAction(service, method, postData) {
            _proxyRequestAction(service, method, postData);
            _proxyRequestAction('all', method, postData);
            _proxyRequestAction(service, 'all', postData);
            _proxyRequestAction('all', 'all', postData);
        }

        window.addEventListener('foe-helper#loaded', () => {
            while (FoEproxy._getXhrQueue() && FoEproxy._getXhrQueue().length > 0) {
                let xhrRequest = FoEproxy._getXhrQueue().shift();
                FoEproxy._xhrOnLoadHandlerExec.call(xhrRequest);
            }
            FoEproxy._setXhrQueue(null);

            while (wsQueue.length > 0) {
                let wsMessage = wsQueue.shift();
                wsMessageHandlerExec(wsMessage);
            }
            wsQueue = null;
        }, { capture: false, once: true, passive: true });

        window.addEventListener('foe-helper#error-loading', () => {
            FoEproxy._setXhrQueue(null);
            wsQueue = null;
            proxyEnabled = false;
            FoEproxy._setProxyEnabled(false);
        }, { capture: false, once: true, passive: true });

        return {
            getHistory: function () {
                return JSONhistory;
            },

            addHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = proxyMap[service];
                if (!map) {
                    proxyMap[service] = map = {};
                }
                let list = map[method];
                if (!list) {
                    map[method] = list = [];
                }
                if (list.indexOf(callback) !== -1) {
                    return;
                }
                list.push(callback);
            },

            removeHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = proxyMap[service];
                if (!map) return;
                let list = map[method];
                if (!list) return;
                map[method] = list.filter(c => c !== callback);
            },

            addMetaHandler: function (meta, callback) {
                let list = proxyMetaMap[meta];
                if (!list) {
                    proxyMetaMap[meta] = list = [];
                }
                if (list.indexOf(callback) !== -1) {
                    return;
                }
                list.push(callback);
            },

            removeMetaHandler: function (meta, callback) {
                let list = proxyMetaMap[meta];
                if (!list) return;
                proxyMetaMap[meta] = list.filter(c => c !== callback);
            },

            addRawHandler: function (callback) {
                if (proxyRaw.indexOf(callback) !== -1) {
                    return;
                }
                proxyRaw.push(callback);
            },

            removeRawHandler: function (callback) {
                proxyRaw = proxyRaw.filter(c => c !== callback);
            },

            addWsHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = wsHandlerMap[service];
                if (!map) {
                    wsHandlerMap[service] = map = {};
                }
                let list = map[method];
                if (!list) {
                    map[method] = list = [];
                }
                if (list.indexOf(callback) !== -1) {
                    return;
                }
                list.push(callback);
            },

            removeWsHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = wsHandlerMap[service];
                if (!map) return;
                let list = map[method];
                if (!list) return;
                map[method] = list.filter(c => c !== callback);
            },

            addFoeHelperHandler: function (method, callback) {
                this.addWsHandler('FoeHelperService', method, callback);
            },

            removeFoeHelperHandler: function (method, callback) {
                this.removeWsHandler('FoeHelperService', method, callback);
            },

            addRawWsHandler: function (callback) {
                if (wsRawHandler.indexOf(callback) !== -1) {
                    return;
                }
                wsRawHandler.push(callback);
            },

            removeRawWsHandler: function (callback) {
                wsRawHandler = wsRawHandler.filter(c => c !== callback);
            },

            triggerFoeHelperHandler: function (method, data = null) {
                _proxyWsAction('FoeHelperService', method, data);
            },

            addRequestHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = proxyRequestsMap[service];
                if (!map) {
                    proxyRequestsMap[service] = map = {};
                }
                let list = map[method];
                if (!list) {
                    map[method] = list = [];
                }
                if (list.indexOf(callback) !== -1) {
                    return;
                }
                list.push(callback);
            },

            removeRequestHandler: function (service, method, callback) {
                if (method === undefined) {
                    callback = service;
                    service = method = 'all';
                } else if (callback === undefined) {
                    callback = method;
                    method = 'all';
                }

                let map = proxyRequestsMap[service];
                if (!map) return;
                let list = map[method];
                if (!list) return;
                map[method] = list.filter(c => c !== callback);
            },

            // Interne Methoden
            _getProxyMap: () => proxyMap,
            _getMetaMap: () => proxyMetaMap,
            _getProxyRaw: () => proxyRaw,
            _getProxyRequestsMap: () => proxyRequestsMap,
            _proxyAction: proxyAction,
            _proxyRequestAction: proxyRequestAction,
            _addToHistory: (entry) => { JSONhistory.push(entry); }
        };
    })());
}