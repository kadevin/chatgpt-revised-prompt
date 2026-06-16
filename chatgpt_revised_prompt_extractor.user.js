// ==UserScript==
// @name         ChatGPT 图片生成优化提示词提取器
// @namespace    https://github.com/kadevin/chatgpt-revised-prompt
// @version      0.3.1
// @description  手动提取 ChatGPT 图片生成优化提示词 + 提示词库管理与快捷填入
// @author       iLab
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js
// @license      MIT
// ==/UserScript==
(function () {
    'use strict';

    // ============================================================
    // Section 1: Configuration & Logging
    // ============================================================
    const DEBUG = true;
    function log(...a) { if (DEBUG) console.log('%c[GPT Suite]', 'color:#10a37f;font-weight:bold', ...a); }

    const Config = {
        STORAGE_KEY: 'promptManager.prompts',
        CATEGORIES_KEY: 'promptManager.categories',
        MODE_KEY: 'promptManager.panelMode',
        FREQUENT_ORDER_KEY: 'promptManager.frequentOrder',
        CAT_ORDER_KEY: 'promptManager.categoryOrder',
        PANEL_ID: 'gpt-panel',
        FAB_ID: 'gpt-fab',
        VERSION: '0.3.1',
        DEFAULT_CATEGORIES: ['通用模板', '人物描述', '风格', '构图', '光影与质感', '负面提示词', '文字与签名'],
    };

    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function escAttr(s) { return escHtml(String(s)).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    // ============================================================
    // Section 2: Storage Service
    // ============================================================
    const StorageService = {
        async load() {
            let prompts = (await GM_getValue(Config.STORAGE_KEY)) || [];
            let migrated = false;
            for (const p of prompts) {
                if (p.lastUsedAt === undefined) { p.lastUsedAt = null; migrated = true; }
                if (p.editedAt !== undefined) { delete p.editedAt; migrated = true; }
                if (p.sortOrder === undefined) { p.sortOrder = 0; migrated = true; }
            }
            if (migrated) {
                // Assign initial sortOrder by updatedAt desc (newest first = lower number)
                const sorted = [...prompts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
                sorted.forEach((p, i) => { p.sortOrder = i; });
                await GM_setValue(Config.STORAGE_KEY, prompts);
            }
            return prompts;
        },
        async save(prompts) {
            await GM_setValue(Config.STORAGE_KEY, prompts);
        },
        async loadCategories() {
            const stored = await GM_getValue(Config.CATEGORIES_KEY);
            if (stored && Array.isArray(stored)) return stored;
            // First load: migrate from DEFAULT_CATEGORIES
            await GM_setValue(Config.CATEGORIES_KEY, [...Config.DEFAULT_CATEGORIES]);
            return [...Config.DEFAULT_CATEGORIES];
        },
        async saveCategories(cats) {
            await GM_setValue(Config.CATEGORIES_KEY, cats);
        },
        async loadFrequentOrder() {
            return (await GM_getValue(Config.FREQUENT_ORDER_KEY)) || [];
        },
        async saveFrequentOrder(order) {
            await GM_setValue(Config.FREQUENT_ORDER_KEY, order);
        },
        async loadCategoryOrder() {
            return (await GM_getValue(Config.CAT_ORDER_KEY)) || [];
        },
        async saveCategoryOrder(order) {
            await GM_setValue(Config.CAT_ORDER_KEY, order);
        },
        exportJSON(prompts) {
            const exported = prompts.map(({ usageCount, lastUsedAt, sortOrder, ...rest }) => rest);
            const data = { app: 'Prompt Manager', schemaVersion: 1, exportedAt: new Date().toISOString(), prompts: exported };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `prompt-manager-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        },
        async importJSON(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const data = JSON.parse(reader.result);
                        if (!data.prompts || !Array.isArray(data.prompts)) { reject(new Error('无效的提示词备份文件')); return; }
                        resolve(data.prompts);
                    } catch(e) { reject(new Error('文件解析失败')); }
                };
                reader.onerror = () => reject(new Error('文件读取失败'));
                reader.readAsText(file);
            });
        },
    };

    // ============================================================
    // Section 3: Prompt Service
    // ============================================================
    const PromptService = {
        create(data) {
            return {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                title: data.title || '',
                content: data.content || '',
                category: data.category || '通用模板',
                tags: data.tags || [],
                favorite: false,
                usageCount: 0,
                sortOrder: data.sortOrder || 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastUsedAt: null,
            };
        },
        update(prompt, data) {
            return { ...prompt, ...data, updatedAt: new Date().toISOString() };
        },
        search(keyword, prompts) {
            if (!keyword) return prompts;
            const kw = keyword.toLowerCase();
            return prompts.filter(p =>
                p.title.toLowerCase().includes(kw) ||
                p.content.toLowerCase().includes(kw) ||
                (p.tags || []).some(t => t.toLowerCase().includes(kw))
            );
        },
        filterByCategory(category, prompts) {
            if (!category || category === '全部') return prompts;
            return prompts.filter(p => p.category === category);
        },
        sortByRecent(prompts) {
            return [...prompts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        },
    };

    // ============================================================
    // Section 3.5: Template Variable Functions
    // ============================================================
    function parseTemplate(template) {
        const variables = [];
        const seen = new Set();
        template.replace(/{([^{}]+)}/g, (_, inner) => {
            const eqIdx = inner.indexOf("=");
            const varName = (eqIdx > -1 ? inner.slice(0, eqIdx) : inner).trim();
            if (!seen.has(varName)) {
                seen.add(varName);
                const defaultVal = eqIdx > -1 ? inner.slice(eqIdx + 1).replace(/^['"‘“]|['"’”]$/g, "") : null;
                variables.push({ name: varName, defaultVal: defaultVal || null });
            }
            return "";
        });
        return variables;
    }

            function unwrapInput(text) {
        const s = text;
        if (s.length >= 2) {
            const o = s.charCodeAt(0);
            const c = s.charCodeAt(s.length - 1);
            // 39=', 34=", 8216=‘, 8217=’, 8220=“, 8221=”
            if ((o === 39 && c === 39) || (o === 34 && c === 34) ||
                (o === 8216 && c === 8217) || (o === 8220 && c === 8221)) {
                return { raw: s.slice(1, -1) };
            }
        }
        return { error: "输入内容必须整体由一组成对引号包裹" };
    }

    function splitEscaped(raw) {
        if (raw === '') return [];
        return raw.split(/(?<!\\)\|/).map(s =>
            s.replace(/\\\|/g, '|').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
        );
    }

    function resolveArgs(variables, tokens) {
        const values = {};
        const occupied = new Set();
        const skipped = new Set();
        const errors = [];
        let pointer = 0;
        const varNames = new Set(variables.map(v => v.name));

        for (const token of tokens) {
            const eqIdx = token.indexOf('=');
            const isNamed = eqIdx > 0 && varNames.has(token.slice(0, eqIdx));

            if (isNamed) {
                const name = token.slice(0, eqIdx);
                const val = token.slice(eqIdx + 1);
                if (occupied.has(name)) { errors.push('变量「' + name + '」被重复赋值'); continue; }
                if (val === '') { skipped.add(name); occupied.add(name); }
                else { values[name] = val; occupied.add(name); }
            } else if (eqIdx > 0 && /^[a-zA-Z0-9_一-鿿㐀-䶿]+$/.test(token.slice(0, eqIdx))) {
                // Looks like a named param but variable doesn't exist
                errors.push('未知变量「' + token.slice(0, eqIdx) + '」，模板中不存在该变量');
            } else {
                while (pointer < variables.length && occupied.has(variables[pointer].name)) pointer++;
                if (pointer >= variables.length) { errors.push("顺序参数过多，多余：「" + token + "」"); continue; }
                const v = variables[pointer];
                if (token === "") { skipped.add(v.name); occupied.add(v.name); }
                else { values[v.name] = token; occupied.add(v.name); }
                pointer++;
            }
        }
        return { values, skipped, occupied, errors };
    }

    function fillTemplate(template, variables, result) {
        if (!result) return template;
        return template.replace(/{([^{}]+)}/g, (fullMatch, inner) => {
            const eqIdx = inner.indexOf("=");
            const varName = (eqIdx > -1 ? inner.slice(0, eqIdx) : inner).trim();
            const defaultVal = eqIdx > -1 ? inner.slice(eqIdx + 1).replace(/^['"‘“]|['"’”]$/g, "") : null;
            if (varName in result.values) return result.values[varName];
            if (result.skipped.has(varName) && defaultVal) return defaultVal;
            if (defaultVal) return defaultVal;
            return fullMatch;
        });
    }

    function readArgsFromEditor() {
        const ev = SiteAdapter.getEditorView();
        if (!ev) return null;
        const text = ev.state.doc.textContent.trim();
        if (!text) return null;
        const unwrapped = unwrapInput(text);
        if (unwrapped.error) return null; // not quoted = no args, treat as regular text
        return { tokens: splitEscaped(unwrapped.raw) };
    }

    function clearEditor() {
        const ev = SiteAdapter.getEditorView();
        if (!ev) return;
        try {
            const tr = ev.state.tr.delete(0, ev.state.doc.content.size);
            ev.props.dispatchTransaction.call(ev, tr);
        } catch(e) {}
    }

    // ============================================================
    // Section 4: Site Adapter (ProseMirror Insertion)
    // ============================================================
    const SiteAdapter = {
        _editorView: null,

        _findEditorView() {
            // Use unsafeWindow to get real DOM element with __reactFiber keys
            const pm = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).document.getElementById('prompt-textarea');
            if (!pm) return null;
            const pmParent = pm.parentElement;
            if (!pmParent) return null;
            const fiberKey = Object.keys(pmParent).find(k => k.startsWith('__reactFiber'));
            if (!fiberKey) return null;

            // Walk to React root fiber
            let root = pmParent[fiberKey];
            let walkSteps = 0;
            while (root.return && walkSteps < 5000) { root = root.return; walkSteps++; }

            // DFS from root: check every component's hooks for the ProseMirror EditorView
            // (ChatGPT minified component names change across deployments)
            const stack = [root];
            let iter = 0;
            while (stack.length > 0 && iter < 20000) {
                iter++;
                const fiber = stack.pop();
                if (!fiber) continue;

                let hook = fiber.memoizedState;
                let hookIdx = 0;
                while (hook && hookIdx < 20) {
                    const ms = hook.memoizedState;
                    if (ms && typeof ms === 'object' && ms.state && ms.dispatch) return ms;
                    hook = hook.next;
                    hookIdx++;
                }

                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
            }
            return null;
        },

        getEditorView() {
            if (this._editorView && this._editorView.dom?.isConnected) return this._editorView;
            this._editorView = this._findEditorView();
            return this._editorView;
        },

        insertText(text, mode = 'append') {
            const ev = this.getEditorView();
            if (!ev) return false;
            try {
                const schema = ev.state.schema;
                const lines = text.split('\n');
                const newParagraphs = lines.map(line =>
                    line === '' ? schema.nodes.paragraph.create() : schema.nodes.paragraph.create(null, schema.text(line))
                );
                let tr;
                if (mode === 'append' && ev.state.doc.content.size > 2) {
                    const endPos = ev.state.doc.content.size - 1;
                    tr = ev.state.tr.insert(endPos, newParagraphs);
                } else {
                    const content = schema.nodes.doc.create(null, newParagraphs);
                    tr = ev.state.tr.replaceWith(0, ev.state.doc.content.size, content.content);
                }
                ev.props.dispatchTransaction.call(ev, tr);
                return true;
            } catch(e) { log('insertText error:', e); return false; }
        },

        clearInput() {
            const ev = this.getEditorView();
            if (!ev) return false;
            try {
                const tr = ev.state.tr.delete(0, ev.state.doc.content.size);
                ev.props.dispatchTransaction.call(ev, tr);
                return true;
            } catch(e) { return false; }
        },
    };

    // ============================================================
    // Section 5: Token & API Layer
    // ============================================================
    let _cachedToken = null;
    let _tokenExpiry = 0;

    function getConversationId() {
        const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
        return m ? m[1] : null;
    }

    function getAccessToken() {
        try {
            const doc = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).document;
            const el = doc.getElementById('client-bootstrap');
            if (el) {
                const d = JSON.parse(el.textContent);
                const t = d?.accessToken || d?.session?.accessToken || null;
                if (t) { _cachedToken = t; _tokenExpiry = Date.now() + 8 * 60 * 1000; return t; }
            }
        } catch(e) {}
        if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
        return null;
    }

    async function refreshAccessToken() {
        try {
            log('刷新 access token...');
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const resp = await win.fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
            if (resp.ok) {
                const data = await resp.json();
                const t = data?.accessToken;
                if (t) { _cachedToken = t; _tokenExpiry = Date.now() + 8 * 60 * 1000; log('Token 已刷新'); return t; }
            }
        } catch(e) { log('刷新 token 失败:', e.message); }
        return null;
    }

    // ============================================================
    // Section 6: Extraction Engine
    // ============================================================
    let allRounds = [];
    const seenPrompts = new Set();
    let lastFetchTime = 0;
    let lastFetchConvId = '';
    const FETCH_COOLDOWN = 5000;
    let isFetchingPrompts = false;
    let _userUploadedFileIds = new Set();

    function getOrderedPath(mapping) {
        const childrenOf = {};
        for (const [id, node] of Object.entries(mapping)) {
            const pid = node.parent;
            if (pid) { if (!childrenOf[pid]) childrenOf[pid] = []; childrenOf[pid].push(id); }
        }
        for (const pid of Object.keys(childrenOf)) {
            childrenOf[pid].sort((a, b) => {
                const ta = mapping[a]?.message?.create_time || 0;
                const tb = mapping[b]?.message?.create_time || 0;
                return ta - tb;
            });
        }
        const root = Object.keys(mapping).find(id => !mapping[id].parent);
        if (!root) return Object.keys(mapping);
        const path = [];
        const visited = new Set();
        const stack = [root];
        while (stack.length > 0) {
            const cur = stack.pop();
            if (visited.has(cur)) continue;
            visited.add(cur);
            path.push(cur);
            const ch = childrenOf[cur] || [];
            for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
        }
        path.sort((a, b) => (mapping[a]?.message?.create_time || 0) - (mapping[b]?.message?.create_time || 0));
        return path;
    }

    function extractImageUrlsFromParts(parts, excludeFileIds = _userUploadedFileIds) {
        const urls = [];
        const fileIds = [];
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.asset_pointer && typeof part.asset_pointer === 'string') {
                const fid = part.asset_pointer.replace('file-service://', '');
                if (fid) fileIds.push(fid);
            }
            if (typeof part.url === 'string' && part.url.startsWith('http')) urls.push(part.url);
            if (part.image_url?.url) urls.push(part.image_url.url);
            const gen = part.metadata?.generation;
            if (gen?.image_url) urls.push(gen.image_url);
            if (gen?.url) urls.push(gen.url);
            const dalle = part.metadata?.dalle;
            if (dalle?.image_url) urls.push(dalle.image_url);
            if (dalle?.url) urls.push(dalle.url);
        }
        for (const fid of fileIds) {
            if (excludeFileIds.has(fid)) continue;
            const img = document.querySelector(`img[src*="${fid}"]`);
            if (img && img.src) urls.push(img.src);
        }
        return [...new Set(urls)];
    }

    function extractFileIdsFromParts(parts) {
        const ids = [];
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.asset_pointer && typeof part.asset_pointer === 'string') ids.push(part.asset_pointer.replace('file-service://', ''));
        }
        return ids;
    }

    function isImageInUserMessage(img) {
        const msgEl = img.closest('[data-message-author-role]');
        if (msgEl && msgEl.getAttribute('data-message-author-role') === 'user') return true;
        const msgContainer = img.closest('[data-message-id]');
        if (msgContainer) { if (msgContainer.querySelector('[data-message-author-role="user"]')) return true; }
        return false;
    }

    function getAllDomImages(excludeFileIds = _userUploadedFileIds) {
        const mainArea = document.querySelector('#thread') || document.querySelector('main') || document.body;
        const allImgs = [...mainArea.querySelectorAll('img[src^="https"]')];
        const results = allImgs.filter(img => {
            const s = img.src;
            if (s.includes('cdn.openai.com') || s.includes('favicon') || s.includes('sprites') || s.includes('avatar') || s.includes('og.png')) return false;
            if (isImageInUserMessage(img)) return false;
            for (const fid of excludeFileIds) { if (s.includes(fid)) return false; }
            if (s.includes('oaiusercontent') || s.includes('openai.com/file') || s.includes('dalleprodsec')) return true;
            if (img.naturalWidth >= 100 || img.width >= 100) return true;
            if (img.alt && img.alt.length > 5) return true;
            return false;
        }).map(img => img.src);
        return [...new Set(results)];
    }

    function getImagesFromDomByMsgId(msgId, excludeFileIds = _userUploadedFileIds) {
        if (!msgId) return [];
        let el = document.querySelector(`[data-message-id="${msgId}"]`);
        if (el) {
            const imgs = [...el.querySelectorAll('img[src^="https"]')].filter(img => {
                const s = img.src;
                if (s.includes('cdn.openai.com') || s.includes('favicon') || s.includes('sprites')) return false;
                if (isImageInUserMessage(img)) return false;
                for (const fid of excludeFileIds) { if (s.includes(fid)) return false; }
                return true;
            }).map(img => img.src);
            if (imgs.length) return imgs;
        }
        return [];
    }

    function extractPromptsFromCode(codeText) {
        const prompts = [];
        const r1 = /prompt\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/g;
        let m;
        while ((m = r1.exec(codeText)) !== null) { const p = (m[1]||m[2]||'').trim(); if (p.length > 20) prompts.push(p); }
        if (!prompts.length) {
            const r2 = /prompt\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            while ((m = r2.exec(codeText)) !== null) { const p = (m[1]||m[2]||'').trim(); if (p.length > 20) prompts.push(p); }
        }
        if (!prompts.length) {
            const r3 = /text2im\s*\(\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            while ((m = r3.exec(codeText)) !== null) { const p = (m[1]||m[2]||m[3]||m[4]||'').trim(); if (p.length > 20) prompts.push(p); }
        }
        return prompts;
    }

    function buildRounds(conversationData) {
        const mapping = conversationData?.mapping;
        if (!mapping) return { rounds: [], userUploadedFileIds: new Set() };
        const path = getOrderedPath(mapping);
        const rounds = [];
        let currentRound = null;
        let lastAssistantMsgId = null;
        const userUploadedFileIds = new Set();

        function addPrompt(prompt, source, imageUrls, toolMsgId, fileIds) {
            if (!currentRound) { currentRound = { roundIndex: rounds.length + 1, userText: '...', prompts: [] }; rounds.push(currentRound); }
            const cleaned = prompt.replace(/<\|[a-z_]+\|>/gi, '').replace(/\s+$/, '');
            if (cleaned.length < 10 || seenPrompts.has(cleaned)) return;
            seenPrompts.add(cleaned);
            currentRound.prompts.push({
                id: String(Math.random()).slice(2), prompt: cleaned, source, imageUrls,
                fileIds: fileIds || [], selected: false, toolMsgId, lastAssistantMsgId,
            });
        }

        for (const nodeId of path) {
            const node = mapping[nodeId];
            const msg = node?.message;
            if (!msg) continue;
            const role = msg.author?.role;
            const ct = msg.content?.content_type;
            const parts = msg.content?.parts;
            const msgId = msg.id;

            if (role === 'user') {
                const firstPart = parts?.[0];
                if (ct === 'user_editable_context') continue;
                currentRound = { roundIndex: rounds.length + 1, userText: '', prompts: [] };
                const up = typeof firstPart === 'string' ? firstPart.substring(0, 40) : '';
                currentRound.userText = up;
                rounds.push(currentRound);
                lastAssistantMsgId = null;
                if (Array.isArray(parts)) {
                    for (const part of parts) {
                        if (part && typeof part === 'object' && part.asset_pointer && typeof part.asset_pointer === 'string') {
                            const fid = part.asset_pointer.replace('file-service://', '');
                            if (fid) userUploadedFileIds.add(fid);
                        }
                    }
                }
            }
            if (role === 'system') continue;
            if (role === 'assistant') lastAssistantMsgId = msgId;

            if (role === 'assistant' && ct === 'code' && Array.isArray(parts)) {
                for (const part of parts) {
                    if (typeof part !== 'string') continue;
                    for (const cp of extractPromptsFromCode(part)) addPrompt(cp, 'code', [], msgId);
                }
            }
            if (role === 'tool' && ct === 'multimodal_text' && Array.isArray(parts)) {
                const imgUrls = extractImageUrlsFromParts(parts);
                const fids = extractFileIdsFromParts(parts);
                for (const part of parts) {
                    if (typeof part === 'string' && part.startsWith('Model caption:')) {
                        const cap = part.substring('Model caption:'.length).trim();
                        if (cap.length > 20) addPrompt(cap, 'caption', imgUrls, msgId, fids);
                    }
                    if (part && typeof part === 'object' && part.metadata) {
                        const gen = part.metadata.generation;
                        if (typeof gen === 'string' && gen.length > 20) addPrompt(gen, 'generation', imgUrls, msgId, fids);
                        else if (gen?.prompt?.length > 20) addPrompt(gen.prompt, 'gen.prompt', imgUrls, msgId, fids);
                        const pd = part.metadata.dalle;
                        if (pd) {
                            const rp = pd.revised_prompt || (pd.prompt?.length > 10 ? pd.prompt : null);
                            if (rp) addPrompt(rp, 'dalle', imgUrls, msgId, fids);
                        }
                    }
                }
            }
            const dalle = msg.metadata?.dalle;
            if (dalle) { const rp = dalle.revised_prompt || (dalle.prompt?.length > 10 ? dalle.prompt : null); if (rp) addPrompt(rp, 'meta.dalle', [], msgId); }
            const igMeta = msg.metadata?.image_generation || msg.metadata?.image_gen_metadata;
            if (igMeta?.revised_prompt) addPrompt(igMeta.revised_prompt, 'ig_meta', [], msgId);
            const aggP = msg.metadata?.aggregate_result?.dalle?.prompts;
            if (Array.isArray(aggP)) for (const dp of aggP) { if (dp?.revised_prompt) addPrompt(dp.revised_prompt, 'agg', [], msgId); }
        }
        const filtered = rounds.filter(r => r.prompts.length > 0);
        filtered.forEach((r, i) => r.roundIndex = i + 1);
        return { rounds: filtered, userUploadedFileIds };
    }

    function enrichWithDomImages(rounds, conversationData, excludeFileIds = _userUploadedFileIds) {
        const domImgs = getAllDomImages(excludeFileIds);
        const allP = rounds.flatMap(r => r.prompts);
        if (conversationData?.mapping) {
            for (const item of allP.filter(p => p.imageUrls.length === 0)) {
                if (!item.toolMsgId) continue;
                for (const [, node] of Object.entries(conversationData.mapping)) {
                    if (node?.message?.id === item.toolMsgId) {
                        const parts = node.message.content?.parts;
                        if (!Array.isArray(parts)) break;
                        const fileIds = extractFileIdsFromParts(parts);
                        for (const fid of fileIds) {
                            if (excludeFileIds.has(fid)) continue;
                            const domMatch = domImgs.find(url => url.includes(fid));
                            if (domMatch && !item.imageUrls.includes(domMatch)) item.imageUrls.push(domMatch);
                        }
                        break;
                    }
                }
            }
        }
        for (const item of allP.filter(p => p.imageUrls.length === 0)) {
            const tryIds = [item.toolMsgId, item.lastAssistantMsgId].filter(Boolean);
            for (const mid of tryIds) { const urls = getImagesFromDomByMsgId(mid); if (urls.length) { item.imageUrls = urls; break; } }
        }
        if (domImgs.length > 0) {
            const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
            const unusedDomImgs = domImgs.filter(u => !usedUrls.has(u));
            let idx = 0;
            for (const item of allP.filter(p => p.imageUrls.length === 0)) { if (idx < unusedDomImgs.length) item.imageUrls = [unusedDomImgs[idx++]]; }
        }
    }

    function resolveFileIds(excludeFileIds = _userUploadedFileIds) {
        const allP = allRounds.flatMap(r => r.prompts);
        for (const item of allP) {
            if (item.imageUrls.length > 0 || !item.fileIds || item.fileIds.length === 0) continue;
            for (const fid of item.fileIds) {
                if (excludeFileIds.has(fid)) continue;
                const img = document.querySelector(`img[src*="${fid}"]`);
                if (img && img.src && !item.imageUrls.includes(img.src)) item.imageUrls.push(img.src);
            }
        }
        if (allP.some(p => p.imageUrls.length === 0 && p.fileIds?.length > 0)) {
            const domImgs = getAllDomImages(excludeFileIds);
            const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
            const unused = domImgs.filter(u => !usedUrls.has(u));
            let idx = 0;
            for (const item of allP) { if (item.imageUrls.length === 0 && idx < unused.length) item.imageUrls = [unused[idx++]]; }
        }
    }

    async function fetchAndExtractPrompts(forceRefresh) {
        const convId = getConversationId();
        if (!convId) return;
        const now = Date.now();
        if (!forceRefresh && now - lastFetchTime < FETCH_COOLDOWN) return;
        if (!forceRefresh && convId === lastFetchConvId && allRounds.length > 0) return;

        let token = getAccessToken();
        if (!token) { token = await refreshAccessToken(); if (!token) { toast('无法获取 token，请刷新页面'); return; } }

        lastFetchTime = now;
        log('请求对话数据:', convId);
        try {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            let resp = await win.fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                credentials: 'include',
            });
            if (resp.status === 401 || resp.status === 403) {
                token = await refreshAccessToken();
                if (token) resp = await win.fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include',
                });
            }
            if (resp.status === 429) { toast('请求太频繁，请稍后手动重试'); return; }
            if (!resp.ok) { log('API 返回:', resp.status); return; }

            const data = await resp.json();
            lastFetchConvId = convId;
            seenPrompts.clear();
            const result = buildRounds(data);
            allRounds = result.rounds;
            _userUploadedFileIds = result.userUploadedFileIds;
            enrichWithDomImages(allRounds, data, _userUploadedFileIds);

            const total = allRounds.reduce((s, r) => s + r.prompts.length, 0);
            log(`提取 ${total} 个提示词，${allRounds.length} 轮对话`);
            renderExtractedTab();

            const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
            if (noImgCount > 0) {
                setTimeout(() => { enrichWithDomImages(allRounds, data, _userUploadedFileIds); renderExtractedTab(); }, 3000);
            }
        } catch(e) { log('请求失败:', e.message); }
    }

    async function manualFetchPrompts() {
        if (!getConversationId()) { toast('请先打开一个对话'); return; }
        if (isFetchingPrompts) return;
        const refreshBtn = document.getElementById('gpt-refresh');
        isFetchingPrompts = true;
        if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = `${SVG.refresh} 提取中`; }
        try { await fetchAndExtractPrompts(true); }
        finally { isFetchingPrompts = false; if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = `${SVG.refresh} 提取`; } }
    }

    // ============================================================
    // Section 7: Image Download & ZIP
    // ============================================================
    function getJSZip() {
        if (typeof JSZip !== 'undefined') return JSZip;
        if (window.JSZip) return window.JSZip;
        return null;
    }

    async function downloadImage(url, filename) {
        try {
            const r = await fetch(url, { credentials: 'include' });
            const blob = await r.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = filename; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        } catch(e) { window.open(url, '_blank'); }
    }

    async function downloadAsZip(urls, zipName) {
        if (!urls.length) { toast('没有可下载的图片'); return; }
        try {
            toast(`正在打包 ${urls.length} 张图片...`);
            const ZipClass = getJSZip();
            if (!ZipClass) throw new Error('JSZip 未加载');
            const zip = new ZipClass();
            let done = 0;
            for (let i = 0; i < urls.length; i++) {
                try {
                    const r = await fetch(urls[i], { credentials: 'include' });
                    const blob = await r.blob();
                    const ext = blob.type?.includes('png') ? 'png' : blob.type?.includes('webp') ? 'webp' : 'jpg';
                    zip.file(`image-${i+1}.${ext}`, blob); done++;
                } catch(e) { log('图片下载失败:', urls[i]); }
            }
            if (done === 0) { toast('所有图片下载失败'); return; }
            const content = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content); a.download = zipName; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 3000);
            toast(`已打包 ${done} 张图片`);
        } catch(e) { log('ZIP 打包失败:', e.message); toast('打包失败'); }
    }

    // ============================================================
    // Section 8: SVG Icons
    // ============================================================
    const SVG = {
        brush: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>`,
        book: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`,
        arrow: `<svg class="gpt-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
        copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>`,
        download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        img: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".3"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
        save: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
        fill: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
        pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`,
        unpin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M17 17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76V6h1"/><path d="M7 2h10a2 2 0 0 1 0 4h-1v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17"/></svg>`,
    };

    // ============================================================
    // Section 9: UI - Styles
    // ============================================================
    function injectStyles() {
        if (document.getElementById('gpt-styles')) return;
        const s = document.createElement('style');
        s.id = 'gpt-styles';
        s.textContent = `
    /* ---- ChatGPT native-like UI refresh: visual layer only ---- */
    :root{
        --gpt-suite-accent:#10a37f;
        --gpt-suite-accent-hover:#0d8a6b;
        --gpt-suite-danger:#ef4444;
        --gpt-suite-warning:#f59e0b;
        --gpt-suite-info:#3b82f6;
        --gpt-suite-radius-sm:8px;
        --gpt-suite-radius:12px;
        --gpt-suite-radius-lg:18px;
        --gpt-suite-shadow:0 18px 50px rgba(0,0,0,.16),0 0 0 1px rgba(0,0,0,.06);
        --gpt-suite-shadow-soft:0 8px 28px rgba(0,0,0,.12);
    }

    /* ---- Shared shell ---- */
    #gpt-panel,#gpt-fab,.gpt-toast,.pm-modal-overlay{
        --suite-bg:var(--main-surface-primary,#fff);
        --suite-bg-soft:var(--sidebar-surface-primary,#f7f7f8);
        --suite-bg-hover:var(--surface-hover,rgba(0,0,0,.045));
        --suite-border:var(--border-light,rgba(0,0,0,.1));
        --suite-border-strong:var(--border-medium,rgba(0,0,0,.16));
        --suite-text:var(--text-primary,#0d0d0d);
        --suite-text-muted:var(--text-secondary,#6b7280);
        --suite-text-faint:var(--text-tertiary,#9ca3af);
        --suite-code-bg:var(--gray-50,#f4f4f4);
        --suite-focus:rgba(16,163,127,.26);
        box-sizing:border-box;
        font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC","Microsoft YaHei",sans-serif;
    }
    html.dark #gpt-panel,html.dark #gpt-fab,html.dark .gpt-toast,html.dark .pm-modal-overlay{
        --suite-bg:var(--main-surface-primary,#212121);
        --suite-bg-soft:var(--sidebar-surface-primary,#171717);
        --suite-bg-hover:rgba(255,255,255,.075);
        --suite-border:rgba(255,255,255,.12);
        --suite-border-strong:rgba(255,255,255,.18);
        --suite-text:var(--text-primary,#f5f5f5);
        --suite-text-muted:var(--text-secondary,#b4b4b4);
        --suite-text-faint:var(--text-tertiary,#8a8a8a);
        --suite-code-bg:rgba(255,255,255,.06);
        --suite-focus:rgba(16,163,127,.34);
    }
    #gpt-panel *,#gpt-panel *::before,#gpt-panel *::after,.pm-modal *,.pm-modal *::before,.pm-modal *::after{
        box-sizing:border-box;
    }
    #gpt-panel button,.pm-modal button,#gpt-fab{
        font:inherit;
        -webkit-tap-highlight-color:transparent;
    }
    #gpt-panel svg,.pm-modal svg,#gpt-fab svg{
        flex:0 0 auto;
    }
    #gpt-panel{
        flex:0 0 auto;
        width:0;
        height:100%;
        overflow:hidden;
        display:flex;
        flex-direction:column;
        background:var(--suite-bg);
        color:var(--suite-text);
        border-left:1px solid var(--suite-border);
        font-size:14px;
        line-height:1.45;
        transition:width .24s cubic-bezier(.2,.8,.2,1),box-shadow .24s ease,opacity .2s ease;
    }
    #gpt-panel.gpt-open{width:430px}
    #gpt-panel input,#gpt-panel textarea,#gpt-panel select,.pm-modal input,.pm-modal textarea,.pm-modal select{
        font:inherit;
    }
    #gpt-panel input::placeholder,.pm-modal input::placeholder,.pm-modal textarea::placeholder{
        color:var(--suite-text-faint);
    }
    #gpt-panel button:focus-visible,.pm-modal button:focus-visible,#gpt-fab:focus-visible,
    #gpt-panel input:focus-visible,#gpt-panel textarea:focus-visible,#gpt-panel select:focus-visible,
    .pm-modal input:focus-visible,.pm-modal textarea:focus-visible,.pm-modal select:focus-visible{
        outline:2px solid var(--suite-focus);
        outline-offset:2px;
    }

    /* Native-feeling launcher */
    #gpt-fab{
        position:fixed;
        right:22px;
        bottom:84px;
        z-index:99999;
        width:46px;
        height:46px;
        border:1px solid var(--suite-border);
        border-radius:999px;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:center;
        color:var(--suite-text);
        background:var(--suite-bg);
        box-shadow:var(--gpt-suite-shadow-soft);
        transition:transform .18s ease,box-shadow .18s ease,background .18s ease,border-color .18s ease;
        user-select:none;
    }
    #gpt-fab:hover{
        transform:translateY(-2px);
        background:var(--suite-bg-soft);
        border-color:var(--suite-border-strong);
        box-shadow:var(--gpt-suite-shadow);
    }
    #gpt-fab:active{transform:translateY(0) scale(.98)}
    #gpt-fab .gpt-badge{
        position:absolute;
        top:-5px;
        right:-5px;
        min-width:18px;
        height:18px;
        padding:0 5px;
        border-radius:999px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:var(--gpt-suite-accent);
        color:#fff;
        border:2px solid var(--suite-bg);
        font-size:10px;
        font-weight:700;
        line-height:1;
    }

    /* Tabs */
    .gpt-tabs{
        display:flex;
        align-items:center;
        gap:4px;
        padding:10px 10px 0;
        min-height:52px;
        flex-shrink:0;
        background:var(--suite-bg);
        border-bottom:1px solid var(--suite-border);
    }
    .gpt-tab{
        min-width:0;
        flex:1;
        height:40px;
        padding:0 10px;
        border-radius:10px 10px 0 0;
        border-bottom:2px solid transparent;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:7px;
        color:var(--suite-text-muted);
        font-size:13px;
        font-weight:600;
        cursor:pointer;
        user-select:none;
        transition:background .16s ease,color .16s ease,border-color .16s ease;
    }
    .gpt-tab:hover{background:var(--suite-bg-hover);color:var(--suite-text)}
    .gpt-tab.gpt-active{
        color:var(--suite-text);
        border-bottom-color:var(--suite-text);
        background:transparent;
    }
    .gpt-tab-body{flex:1;min-height:0;overflow:hidden;display:none;flex-direction:column;background:var(--suite-bg)}
    .gpt-tab-body.gpt-active{display:flex}
    .gpt-close,.gpt-mode-btn{
        width:34px;
        height:34px;
        padding:0;
        border:none;
        border-radius:10px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:transparent;
        color:var(--suite-text-muted);
        cursor:pointer;
        transition:background .16s ease,color .16s ease,transform .16s ease;
    }
    .gpt-close{margin-left:0}
    .gpt-close:hover,.gpt-mode-btn:hover{background:var(--suite-bg-hover);color:var(--suite-text)}
    .gpt-mode-btn.active{color:var(--gpt-suite-accent);background:rgba(16,163,127,.1)}
    .gpt-close:active,.gpt-mode-btn:active{transform:scale(.96)}

    /* Toast */
    .gpt-toast{
        position:fixed;
        left:50%;
        bottom:86px;
        z-index:100002;
        transform:translateX(-50%) translateY(12px) scale(.98);
        max-width:min(520px,calc(100vw - 32px));
        padding:9px 14px;
        border-radius:999px;
        background:var(--suite-text);
        color:var(--suite-bg);
        box-shadow:var(--gpt-suite-shadow-soft);
        font-size:13px;
        font-weight:500;
        opacity:0;
        pointer-events:none;
        transition:opacity .22s ease,transform .22s ease;
    }
    .gpt-toast.show{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}

    /* ---- Extracted Tab ---- */
    .rp-hdr{
        display:flex;
        align-items:center;
        gap:10px;
        padding:12px 14px;
        flex-shrink:0;
        border-bottom:1px solid var(--suite-border);
        background:var(--suite-bg);
        color:var(--suite-text);
        font-size:14px;
        font-weight:650;
    }
    .rp-hdr-right{
        margin-left:auto;
        display:flex;
        align-items:center;
        gap:8px;
    }
    .rp-refresh,.rp-sel-all,.rp-round-dl,.rp-copy-btn,.rp-dl-btn,.rp-save-btn,.rp-dl-sel-btn,.rp-dl-all-btn,
    .pm-add-btn,.pm-export-btn,.pm-cat-btn,.pm-cat-add,.pm-item-actions button,.pm-modal-btns button{
        border-radius:10px;
        transition:background .16s ease,border-color .16s ease,color .16s ease,transform .12s ease,box-shadow .16s ease;
    }
    .rp-refresh,.rp-sel-all{
        min-height:30px;
        padding:0 10px;
        border:1px solid var(--suite-border);
        background:var(--suite-bg);
        color:var(--suite-text);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:5px;
        font-size:12px;
        font-weight:600;
    }
    .rp-refresh{
        background:var(--suite-text);
        border-color:var(--suite-text);
        color:var(--suite-bg);
    }
    .rp-refresh:hover{box-shadow:0 4px 14px rgba(0,0,0,.12);transform:translateY(-1px)}
    .rp-sel-all:hover{background:var(--suite-bg-hover);border-color:var(--suite-border-strong)}
    .rp-refresh:disabled,.rp-dl-sel-btn:disabled{
        opacity:.52;
        cursor:not-allowed;
        transform:none;
        box-shadow:none;
    }
    .rp-count-badge{
        min-width:34px;
        height:24px;
        padding:0 8px;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        background:var(--suite-bg-soft);
        border:1px solid var(--suite-border);
        color:var(--suite-text-muted);
        font-size:12px;
        font-weight:600;
    }
    .rp-body,.pm-list{
        flex:1;
        min-height:0;
        overflow-y:auto;
        padding:10px;
        scrollbar-width:thin;
        scrollbar-color:var(--suite-border-strong) transparent;
    }
    .rp-body::-webkit-scrollbar,.pm-list::-webkit-scrollbar,.rp-txt::-webkit-scrollbar,.pm-modal::-webkit-scrollbar{width:10px;height:10px}
    .rp-body::-webkit-scrollbar-thumb,.pm-list::-webkit-scrollbar-thumb,.rp-txt::-webkit-scrollbar-thumb,.pm-modal::-webkit-scrollbar-thumb{
        border:3px solid transparent;
        border-radius:999px;
        background:var(--suite-border-strong);
        background-clip:content-box;
    }
    .rp-round-divider{
        display:flex;
        align-items:center;
        gap:8px;
        margin:12px 4px 8px;
        color:var(--suite-text-faint);
        font-size:12px;
        font-weight:650;
    }
    .rp-round-divider::before,.rp-round-divider::after{
        content:"";
        height:1px;
        flex:1;
        background:var(--suite-border);
    }
    .rp-round-dl{
        min-height:24px;
        padding:0 8px;
        border:1px solid var(--suite-border);
        background:var(--suite-bg);
        color:var(--suite-text-muted);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:4px;
        white-space:nowrap;
        font-size:11px;
        font-weight:600;
    }
    .rp-round-dl:hover{background:var(--suite-bg-hover);color:var(--suite-text);border-color:var(--suite-border-strong)}
    .rp-card{
        position:relative;
        overflow:hidden;
        margin-bottom:8px;
        border:1px solid var(--suite-border);
        border-radius:var(--gpt-suite-radius);
        background:var(--suite-bg);
        box-shadow:0 1px 0 rgba(0,0,0,.02);
        transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease;
    }
    .rp-card:hover{
        border-color:var(--suite-border-strong);
        box-shadow:0 4px 14px rgba(0,0,0,.06);
    }
    .rp-card.selected{
        border-color:rgba(16,163,127,.45);
        background:rgba(16,163,127,.055);
    }
    .rp-card.open{box-shadow:0 8px 24px rgba(0,0,0,.08)}
    .rp-card-hdr{
        display:flex;
        align-items:center;
        gap:10px;
        min-height:68px;
        padding:10px;
        cursor:pointer;
        user-select:none;
        color:var(--suite-text-muted);
        transition:background .16s ease;
    }
    .rp-card-hdr:hover{background:var(--suite-bg-hover)}
    .rp-cb{
        appearance:none;
        -webkit-appearance:none;
        width:18px;
        height:18px;
        margin:0;
        flex-shrink:0;
        border:1px solid var(--suite-border-strong);
        border-radius:6px;
        background:var(--suite-bg);
        cursor:pointer;
        position:relative;
        transition:background .14s ease,border-color .14s ease,box-shadow .14s ease;
    }
    .rp-cb:hover{box-shadow:0 0 0 3px var(--suite-focus)}
    .rp-cb:checked{background:var(--gpt-suite-accent);border-color:var(--gpt-suite-accent)}
    .rp-cb:checked::after{
        content:"";
        position:absolute;
        left:5px;
        top:2px;
        width:5px;
        height:9px;
        border:solid #fff;
        border-width:0 2px 2px 0;
        transform:rotate(45deg);
    }
    .rp-thumb-strip{display:flex;gap:6px;flex-shrink:0;position:relative}
    .rp-thumb,.rp-thumb-ph{
        width:52px;
        height:52px;
        border-radius:10px;
        flex-shrink:0;
    }
    .rp-thumb{
        object-fit:cover;
        border:1px solid var(--suite-border);
        background:var(--suite-bg-soft);
        cursor:pointer;
        transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;
    }
    .rp-thumb:hover{transform:scale(1.03);border-color:var(--suite-border-strong);box-shadow:0 5px 14px rgba(0,0,0,.12)}
    .rp-thumb-ph{
        border:1px dashed var(--suite-border-strong);
        background:var(--suite-bg-soft);
        display:flex;
        align-items:center;
        justify-content:center;
        color:var(--suite-text-faint);
    }
    .rp-hover-preview{
        position:fixed;
        z-index:100001;
        pointer-events:none;
        max-width:340px;
        max-height:440px;
        border-radius:16px;
        border:1px solid rgba(255,255,255,.16);
        box-shadow:0 18px 55px rgba(0,0,0,.34);
        opacity:0;
        transition:opacity .16s ease,transform .16s ease;
        transform:translateY(4px);
    }
    .rp-hover-preview.show{opacity:1;transform:translateY(0)}
    .rp-card-meta{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}
    .rp-tag,.pm-tag{
        display:inline-flex;
        align-items:center;
        max-width:100%;
        padding:2px 7px;
        border-radius:999px;
        background:var(--suite-bg-soft);
        border:1px solid var(--suite-border);
        color:var(--suite-text-muted);
        font-size:11px;
        font-weight:650;
        line-height:1.35;
    }
    .rp-tag{align-self:flex-start;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}
    .rp-preview{
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        color:var(--suite-text-muted);
        font-size:12px;
    }
    .rp-arrow{flex-shrink:0;color:var(--suite-text-faint);transition:transform .18s ease,color .18s ease}
    .rp-card.open .rp-arrow{transform:rotate(90deg);color:var(--suite-text)}
    .rp-card-body{display:none;padding:0 10px 10px}
    .rp-card.open .rp-card-body{display:block}
    .rp-txt{
        max-height:180px;
        overflow:auto;
        padding:11px 12px;
        border-radius:10px;
        background:var(--suite-code-bg);
        color:var(--suite-text);
        border:1px solid var(--suite-border);
        font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;
        font-size:12px;
        line-height:1.62;
        white-space:pre-wrap;
        word-break:break-word;
    }
    .rp-card-acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .rp-copy-btn,.rp-dl-btn,.rp-save-btn{
        min-height:34px;
        padding:0 12px;
        border:1px solid var(--suite-border);
        background:var(--suite-bg);
        color:var(--suite-text);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:6px;
        flex:1 1 0;
        font-size:12px;
        font-weight:650;
    }
    .rp-copy-btn:hover,.rp-dl-btn:hover,.rp-save-btn:hover{background:var(--suite-bg-hover);border-color:var(--suite-border-strong);transform:translateY(-1px)}
    .rp-copy-btn.ok,.rp-save-btn.saved{background:var(--gpt-suite-accent);border-color:var(--gpt-suite-accent);color:#fff}
    .rp-dl-btn{color:var(--gpt-suite-info)}
    .rp-save-btn{color:var(--gpt-suite-warning)}
    .rp-footer{
        padding:10px;
        border-top:1px solid var(--suite-border);
        display:flex;
        gap:8px;
        flex-shrink:0;
        background:var(--suite-bg);
    }
    .rp-dl-sel-btn,.rp-dl-all-btn{
        min-height:38px;
        padding:0 12px;
        border:1px solid var(--suite-border);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:7px;
        flex:1;
        font-size:13px;
        font-weight:650;
    }
    .rp-dl-sel-btn{background:var(--suite-text);border-color:var(--suite-text);color:var(--suite-bg)}
    .rp-dl-all-btn{background:var(--suite-bg);color:var(--suite-text)}
    .rp-dl-sel-btn:hover,.rp-dl-all-btn:hover{transform:translateY(-1px);box-shadow:0 5px 16px rgba(0,0,0,.1)}
    .rp-dl-all-btn:hover{background:var(--suite-bg-hover);border-color:var(--suite-border-strong)}
    .rp-empty,.pm-empty{
        margin:28px 10px;
        padding:34px 22px;
        border:1px dashed var(--suite-border-strong);
        border-radius:16px;
        background:var(--suite-bg-soft);
        color:var(--suite-text-muted);
        text-align:center;
        font-size:13px;
    }

    /* ---- Library Tab ---- */
    .pm-search-bar{
        padding:12px 14px;
        border-bottom:1px solid var(--suite-border);
        flex-shrink:0;
        background:var(--suite-bg);
    }
    .pm-search-bar input,.pm-modal input,.pm-modal textarea,.pm-modal select{
        width:100%;
        border:1px solid var(--suite-border);
        border-radius:12px;
        background-color:var(--suite-bg-soft);
        color:var(--suite-text);
        padding:10px 12px;
        font-size:13px;
        outline:none;
        transition:border-color .16s ease,box-shadow .16s ease,background .16s ease;
    }
    .pm-search-bar input:focus,.pm-modal input:focus,.pm-modal textarea:focus,.pm-modal select:focus{
        border-color:rgba(16,163,127,.55);
        box-shadow:0 0 0 4px var(--suite-focus);
        background:var(--suite-bg);
    }
    .pm-categories{
        display:flex;
        gap:8px;
        padding:10px 14px;
        flex-wrap:wrap;
        overflow-x:auto;
        border-bottom:1px solid var(--suite-border);
        background:var(--suite-bg);
        flex-shrink:0;
    }
    .pm-cat-btn,.pm-cat-add{
        min-height:30px;
        padding:0 10px;
        border:1px solid var(--suite-border);
        background:var(--suite-bg-soft);
        color:var(--suite-text-muted);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:5px;
        white-space:nowrap;
        font-size:12px;
        font-weight:600;
    }
    .pm-cat-btn:hover,.pm-cat-add:hover{background:var(--suite-bg-hover);color:var(--suite-text);border-color:var(--suite-border-strong)}
    .pm-cat-btn.pm-active{background:var(--suite-text);border-color:var(--suite-text);color:var(--suite-bg)}
    .pm-cat-del{
        margin-left:2px;
        padding:0;
        border:none;
        background:transparent;
        color:inherit;
        cursor:pointer;
        font-size:14px;
        line-height:1;
        opacity:.55;
    }
    .pm-cat-del:hover{opacity:1;color:var(--gpt-suite-danger)}
    .pm-cat-btn.pm-active .pm-cat-del:hover{color:currentColor}
    .pm-cat-add{border-style:dashed;background:transparent;color:var(--suite-text-faint)}
    .pm-cat-label{display:inline-flex;align-items:center;gap:5px;transform-origin:center center}
    .pm-cat-btn.pm-cat-draggable{cursor:grab;transition:transform .2s ease,box-shadow .2s ease}
    .pm-cat-btn.pm-cat-draggable:active{cursor:grabbing}
    .pm-cat-btn.pm-cat-source{display:none !important}
    .pm-cat-btn.pm-cat-lifted{
        position:fixed !important;
        margin:0 !important;
        z-index:100003;
        pointer-events:none;
        opacity:.99;
        background:var(--suite-bg);
        border-color:rgba(16,163,127,.58);
        box-shadow:0 18px 38px rgba(0,0,0,.22),0 0 0 1px rgba(16,163,127,.18);
        transform:translate3d(var(--pm-cat-dx,0px),var(--pm-cat-dy,0px),0) scale(1.05) rotate(var(--pm-cat-rotate,.35deg));
        transform-origin:center center;
        will-change:transform;
        transition:box-shadow .18s ease,border-color .18s ease,opacity .18s ease;
    }
    html.dark .pm-cat-btn.pm-cat-lifted{box-shadow:0 20px 42px rgba(0,0,0,.54),0 0 0 1px rgba(16,163,127,.28)}
    .pm-categories.pm-cat-reordering .pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source){
        transition:transform .34s cubic-bezier(.16,1,.3,1),box-shadow .18s ease,border-color .18s ease;
    }
    .pm-categories.pm-cat-reordering .pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source) .pm-cat-label{
        animation:pmCatJiggle .62s ease-in-out infinite alternate;
        animation-delay:var(--pm-cat-jiggle-delay,0ms);
    }
    .pm-cat-btn.pm-cat-shifting{z-index:1}
    .pm-cat-placeholder{height:28px;display:inline-flex;flex-shrink:0;border:1px dashed rgba(16,163,127,.38);border-radius:12px;
        background:linear-gradient(90deg,rgba(16,163,127,.075),rgba(16,163,127,.04));
        transition:width .24s cubic-bezier(.16,1,.3,1),transform .24s cubic-bezier(.16,1,.3,1)}
    html.dark .pm-cat-placeholder{background:rgba(16,163,127,.12);border-color:rgba(16,163,127,.42)}
    .pm-cat-btn.pm-cat-drop-pop{animation:pmCatDropPop .32s cubic-bezier(.2,1.25,.2,1)}
    @keyframes pmCatJiggle{
        0%{transform:translate3d(-.35px,0,0) rotate(-.22deg)}
        50%{transform:translate3d(.25px,-.25px,0) rotate(.12deg)}
        100%{transform:translate3d(.35px,.15px,0) rotate(.24deg)}
    }
    @keyframes pmCatDropPop{
        0%{transform:scale(1.08)}
        58%{transform:scale(.96)}
        100%{transform:scale(1)}
    }
    .pm-item{
        position:relative;
        padding:14px;
        margin-bottom:10px;
        border:1px solid var(--suite-border);
        border-radius:16px;
        background:var(--suite-bg);
        cursor:pointer;
        transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease;
    }
    .pm-item:hover{
        border-color:var(--suite-border-strong);
        background:var(--suite-bg);
        box-shadow:0 10px 24px rgba(0,0,0,.065);
        transform:translateY(-1px);
    }
    .pm-item-title{
        display:flex;
        align-items:flex-start;
        gap:8px;
        margin-bottom:7px;
        min-width:0;
        color:var(--suite-text);
        font-size:14px;
        font-weight:700;
        line-height:1.35;
    }
    .pm-item-title > span:not(.pm-item-title-tags){
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        word-break:break-word;
    }
    .pm-item-title .pm-fav{color:var(--gpt-suite-warning);font-size:12px;line-height:1.6}
    .pm-item-title-tags{
        margin-left:auto;
        display:flex;
        gap:5px;
        flex-wrap:wrap;
        justify-content:flex-end;
        max-width:48%;
    }
    .pm-item-preview{
        max-height:44px;
        overflow:hidden;
        margin-bottom:10px;
        color:var(--suite-text-muted);
        font-size:12px;
        line-height:1.6;
    }
    .pm-item-preview:hover{overflow-y:auto;scrollbar-width:none}
    .pm-item-preview:hover::-webkit-scrollbar{display:none}

    /* iOS-like whole-card drag animation */
    .pm-item{
        cursor:grab;
        user-select:none;
        -webkit-user-select:none;
        touch-action:pan-y;
        will-change:transform;
    }
    .pm-item:active{cursor:grabbing}
    .pm-item-inner{
        transform-origin:center center;
        will-change:transform;
    }
    .pm-list.pm-reordering{
        user-select:none;
        -webkit-user-select:none;
    }
    .pm-list.pm-reordering .pm-item:not(.pm-lifted){
        transition:transform .34s cubic-bezier(.16,1,.3,1),box-shadow .18s ease,border-color .18s ease,background .18s ease;
    }
    .pm-list.pm-reordering .pm-item:not(.pm-lifted) .pm-item-inner{
        animation:pmNeighborJiggle .62s ease-in-out infinite alternate;
        animation-delay:var(--pm-jiggle-delay,0ms);
    }
    .pm-list.pm-reordering .pm-item.pm-shifting{
        z-index:1;
    }

    .pm-item.pm-drag-source{
        display:none !important;
    }
    .pm-item.pm-lifted{
        position:fixed !important;
        margin:0 !important;
        z-index:100003;
        pointer-events:none;
        cursor:grabbing;
        opacity:.99;
        border-color:rgba(16,163,127,.58);
        background:var(--suite-bg);
        box-shadow:0 28px 64px rgba(0,0,0,.24),0 0 0 1px rgba(16,163,127,.18);
        transform:translate3d(var(--pm-drag-x,0px),var(--pm-drag-y,0px),0) scale(1.035) rotate(var(--pm-drag-rotate,.45deg));
        transform-origin:center center;
        will-change:transform,left,top;
        transition:box-shadow .18s ease,border-color .18s ease,opacity .18s ease,filter .18s ease;
        filter:saturate(1.02);
    }
    .pm-item.pm-lifted .pm-item-inner{
        animation:pmLiftedJiggle .46s ease-in-out infinite alternate;
    }
    html.dark .pm-item.pm-lifted{box-shadow:0 30px 68px rgba(0,0,0,.56),0 0 0 1px rgba(16,163,127,.28)}
    .pm-drag-placeholder{
        margin-bottom:10px;
        border:1px dashed rgba(16,163,127,.38);
        border-radius:16px;
        background:linear-gradient(180deg,rgba(16,163,127,.075),rgba(16,163,127,.04));
        box-shadow:inset 0 0 0 1px rgba(16,163,127,.04);
        transition:height .24s cubic-bezier(.16,1,.3,1),transform .24s cubic-bezier(.16,1,.3,1),opacity .18s ease;
    }
    html.dark .pm-drag-placeholder{background:rgba(16,163,127,.12);border-color:rgba(16,163,127,.42)}
    .pm-item.pm-drop-pop{animation:pmDropPop .32s cubic-bezier(.2,1.25,.2,1)}
    .pm-item.pm-drop-pop .pm-item-inner{animation:none}
    @keyframes pmNeighborJiggle{
        0%{transform:translate3d(-.35px,0,0) rotate(-.22deg)}
        50%{transform:translate3d(.25px,-.25px,0) rotate(.12deg)}
        100%{transform:translate3d(.35px,.15px,0) rotate(.24deg)}
    }
    @keyframes pmLiftedJiggle{
        0%{transform:rotate(-.38deg)}
        100%{transform:rotate(.48deg)}
    }
    @keyframes pmDropPop{
        0%{transform:scale(1.018)}
        58%{transform:scale(.99)}
        100%{transform:scale(1)}
    }
    .pm-fav-divider{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:11px;
        font-weight:600;color:var(--suite-text-muted);user-select:none}
    .pm-fav-divider::before,.pm-fav-divider::after{content:'';flex:1;height:1px;background:var(--suite-border)}
    .pm-item-meta{
        display:flex;
        flex-direction:column;
        align-items:stretch;
        gap:10px;
    }
    .pm-item-tags{
        display:flex;
        gap:6px;
        flex-wrap:wrap;
        min-width:0;
    }
    .pm-var-tag{
        background:rgba(16,163,127,.08);
        border-color:rgba(16,163,127,.18);
        color:var(--gpt-suite-accent-hover);
    }
    html.dark .pm-var-tag{
        background:rgba(16,163,127,.14);
        border-color:rgba(16,163,127,.24);
        color:#7be0c2;
    }
    .pm-item-actions{
        display:grid;
        grid-template-columns:repeat(5,minmax(0,1fr));
        gap:8px;
        align-items:stretch;
    }
    .pm-item-actions button,.pm-add-btn,.pm-export-btn{
        min-height:34px;
        padding:0 8px;
        border:1px solid var(--suite-border);
        border-radius:10px;
        background:var(--suite-bg-soft);
        color:var(--suite-text-muted);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:5px;
        font-size:11px;
        font-weight:650;
        transition:border-color .15s ease,background .15s ease,color .15s ease,transform .15s ease,box-shadow .15s ease;
    }
    .pm-item-actions button{
        width:100%;
        min-width:0;
    }
    .pm-item-actions button:hover,.pm-add-btn:hover,.pm-export-btn:hover{
        background:var(--suite-bg-hover);
        border-color:var(--suite-border-strong);
        color:var(--suite-text);
        transform:translateY(-1px);
    }
    .pm-btn-ico{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        font-size:12px;
        line-height:1;
        flex-shrink:0;
    }
    .pm-btn-label{
        display:inline-flex;
        align-items:center;
        line-height:1;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
    }
    .pm-btn-fill-send{
        background:rgba(16,163,127,.08) !important;
        border-color:rgba(16,163,127,.18) !important;
        color:var(--gpt-suite-accent-hover) !important;
    }
    .pm-btn-fill-send:hover{
        background:rgba(16,163,127,.14) !important;
        border-color:rgba(16,163,127,.3) !important;
        color:var(--gpt-suite-accent-hover) !important;
    }
    .pm-item-actions .pm-btn-del:hover{border-color:rgba(239,68,68,.35);color:var(--gpt-suite-danger)}
    .pm-add-bar{
        padding:10px 14px;
        border-top:1px solid var(--suite-border);
        flex-shrink:0;
        display:flex;
        gap:8px;
        background:var(--suite-bg);
    }
    .pm-add-btn,.pm-export-btn{
        min-height:40px;
        font-size:12px;
        font-weight:700;
        border-radius:10px;
    }
    .pm-add-btn{flex:1;background:var(--suite-text);border-color:var(--suite-text);color:var(--suite-bg)}
    .pm-export-btn{padding:0 14px;background:var(--suite-bg);color:var(--suite-text)}
    .pm-add-btn:hover,.pm-export-btn:hover{box-shadow:0 5px 16px rgba(0,0,0,.1)}
    .pm-export-btn:hover{background:var(--suite-bg-hover);border-color:var(--suite-border-strong)}

    /* ---- Modal ---- */
    .pm-modal-overlay{
        position:fixed;
        inset:0;
        z-index:100000;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:18px;
        background:rgba(0,0,0,.42);
        backdrop-filter:blur(6px);
    }
    .pm-modal{
        width:min(390px,calc(100vw - 32px));
        max-height:min(82vh,720px);
        overflow-y:auto;
        padding:18px;
        border:1px solid var(--suite-border);
        border-radius:18px;
        background:var(--suite-bg);
        color:var(--suite-text);
        box-shadow:var(--gpt-suite-shadow);
    }
    .pm-modal h4{
        margin:0 0 16px;
        color:var(--suite-text);
        font-size:16px;
        font-weight:750;
        letter-spacing:-.01em;
    }
    .pm-modal label{
        display:block;
        margin:0 0 6px;
        color:var(--suite-text-muted);
        font-size:12px;
        font-weight:650;
    }
    .pm-modal textarea{min-height:112px;resize:vertical;line-height:1.55}
    .pm-modal input,.pm-modal textarea,.pm-modal select{margin-bottom:13px}
    .pm-modal select.pm-select-native{display:none}
    .pm-select{
        position:relative;
        z-index:2;
        margin-bottom:13px;
    }
    .pm-select.pm-open{z-index:30}
    .pm-select-trigger{
        width:100%;
        min-height:42px;
        padding:0 12px 0 13px;
        border:1px solid var(--suite-border);
        border-radius:12px;
        background:
            linear-gradient(180deg,rgba(255,255,255,.035),rgba(16,163,127,.025)),
            var(--suite-bg-soft);
        color:var(--suite-text);
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
        transition:border-color .16s ease,box-shadow .16s ease,background .16s ease,transform .12s ease;
    }
    .pm-select-trigger:hover{
        border-color:var(--suite-border-strong);
        background:var(--suite-bg-hover);
    }
    .pm-select.pm-open .pm-select-trigger{
        border-color:rgba(16,163,127,.56);
        background:var(--suite-bg);
        box-shadow:0 0 0 4px var(--suite-focus),0 8px 22px rgba(0,0,0,.08);
    }
    .pm-select-value{
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-size:13px;
        font-weight:650;
    }
    .pm-select-arrow{
        width:24px;
        height:24px;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        color:var(--suite-text-muted);
        background:rgba(16,163,127,.08);
        transition:transform .16s ease,color .16s ease,background .16s ease;
    }
    .pm-select.pm-open .pm-select-arrow{
        transform:rotate(180deg);
        color:var(--suite-text);
        background:rgba(16,163,127,.14);
    }
    .pm-select-menu{
        position:absolute;
        left:0;
        right:0;
        top:calc(100% + 7px);
        max-height:188px;
        overflow:auto;
        padding:6px;
        border:1px solid var(--suite-border);
        border-radius:14px;
        background:var(--suite-bg);
        box-shadow:0 18px 48px rgba(0,0,0,.18),0 0 0 1px rgba(16,163,127,.04);
        opacity:0;
        transform:translateY(-4px) scale(.985);
        pointer-events:none;
        transform-origin:top center;
        transition:opacity .14s ease,transform .16s cubic-bezier(.16,1,.3,1);
    }
    .pm-select.pm-open .pm-select-menu{
        opacity:1;
        transform:translateY(0) scale(1);
        pointer-events:auto;
    }
    .pm-select-option{
        width:100%;
        min-height:34px;
        padding:0 10px;
        border:1px solid transparent;
        border-radius:10px;
        background:transparent;
        color:var(--suite-text-muted);
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        font-size:13px;
        font-weight:600;
        text-align:left;
    }
    .pm-select-option:hover,.pm-select-option:focus-visible{
        background:var(--suite-bg-hover);
        color:var(--suite-text);
        outline:none;
    }
    .pm-select-option.pm-selected{
        border-color:rgba(16,163,127,.22);
        background:rgba(16,163,127,.1);
        color:var(--suite-text);
    }
    .pm-select-check{
        color:var(--gpt-suite-accent);
        font-size:12px;
        opacity:0;
    }
    .pm-select-option.pm-selected .pm-select-check{opacity:1}
    .pm-modal-btns{
        display:flex;
        justify-content:flex-end;
        gap:9px;
        margin-top:6px;
    }
    .pm-modal-btns button{
        min-height:38px;
        padding:0 16px;
        border:1px solid var(--suite-border);
        cursor:pointer;
        font-size:13px;
        font-weight:700;
    }
    .pm-btn-cancel{background:var(--suite-bg);color:var(--suite-text)}
    .pm-btn-save{background:var(--suite-text);border-color:var(--suite-text) !important;color:var(--suite-bg)}
    .pm-btn-cancel:hover{background:var(--suite-bg-hover);border-color:var(--suite-border-strong)}
    .pm-btn-save:hover{transform:translateY(-1px);box-shadow:0 5px 16px rgba(0,0,0,.12)}
    .pm-btn-danger{background:#ef4444;color:#fff;border:none;border-radius:10px;padding:8px 22px;
        font-size:13px;font-weight:600;cursor:pointer;transition:all .15s ease}
    .pm-btn-danger:hover{background:#dc2626;transform:translateY(-1px);box-shadow:0 5px 16px rgba(239,68,68,.25)}
    .pm-dialog-modal{max-width:480px}
    .pm-dialog-body{font-size:13px;color:var(--suite-text-muted);line-height:1.7;margin-bottom:16px}
    .pm-dialog-input{width:100%;box-sizing:border-box;border:1px solid var(--suite-border);border-radius:12px;
        background-color:var(--suite-bg-soft);color:var(--suite-text);padding:10px 12px;font-size:13px;
        outline:none;margin-bottom:16px;transition:border-color .16s ease,box-shadow .16s ease}
    .pm-dialog-input:focus{border-color:rgba(16,163,127,.55);box-shadow:0 0 0 4px var(--suite-focus)}

    /* ---- Import conflict dialog ---- */
    .pm-conflict-modal{width:520px;max-height:80vh}
    .pm-conflict-desc{font-size:12px;color:var(--suite-text-muted);margin-bottom:12px}
    .pm-conflict-global{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
    .pm-conflict-global-btn{padding:6px 12px;border:1px solid var(--suite-border);border-radius:8px;
        background:var(--suite-bg-soft);color:var(--suite-text-muted);font-size:12px;
        cursor:pointer;transition:all .15s}
    .pm-conflict-global-btn:hover{border-color:#10a37f;color:#10a37f}
    .pm-conflict-global-btn.pm-conflict-active{background:#10a37f;border-color:#10a37f;color:#fff}
    .pm-conflict-list{max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;margin-bottom:12px}
    .pm-conflict-item{background:var(--suite-bg-soft);border:1px solid var(--suite-border);border-radius:8px;padding:12px}
    .pm-conflict-title{font-weight:600;font-size:13px;color:var(--suite-text);margin-bottom:2px}
    .pm-conflict-id{font-size:10px;color:var(--suite-text-muted);font-family:'SF Mono',Menlo,monospace;margin-bottom:8px}
    .pm-conflict-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
    .pm-conflict-side{border:1px solid var(--suite-border);border-radius:6px;padding:8px;min-height:60px}
    .pm-conflict-local{border-color:rgba(59,130,246,.3)}
    .pm-conflict-imported{border-color:rgba(16,163,127,.3)}
    .pm-conflict-side-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .pm-conflict-side-label{font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px}
    .pm-conflict-local .pm-conflict-side-label{background:rgba(59,130,246,.1);color:#3b82f6}
    .pm-conflict-imported .pm-conflict-side-label{background:rgba(16,163,127,.1);color:#10a37f}
    .pm-conflict-side-time{font-size:10px;color:var(--suite-text-muted)}
    .pm-conflict-newer{color:#10a37f;font-weight:600}
    .pm-conflict-side-content{font-size:11px;color:var(--suite-text);line-height:1.5;
        max-height:100px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;
        font-family:'SF Mono',Menlo,Consolas,monospace}
    .pm-conflict-actions{display:flex;gap:6px;justify-content:flex-end}
    .pm-conflict-btn{padding:5px 14px;border:1px solid var(--suite-border);border-radius:6px;
        background:transparent;color:var(--suite-text-muted);font-size:12px;cursor:pointer;transition:all .15s}
    .pm-conflict-btn:hover{border-color:#10a37f;color:#10a37f}
    .pm-conflict-btn.pm-conflict-active{background:#10a37f;border-color:#10a37f;color:#fff}
    .pm-conflict-hint{font-size:12px;color:var(--suite-text-muted);text-align:center;padding:16px 0}

    /* ---- Floating mode overrides ---- */
    #gpt-panel.gpt-floating{
        position:fixed;
        right:22px;
        bottom:140px;
        z-index:99998;
        width:410px;
        height:auto;
        max-height:min(72vh,760px);
        border:1px solid var(--suite-border);
        border-radius:20px;
        box-shadow:var(--gpt-suite-shadow);
        display:none;
        overflow:hidden;
    }
    #gpt-panel.gpt-floating.gpt-open{display:flex}
    html.dark #gpt-panel.gpt-floating{box-shadow:0 18px 55px rgba(0,0,0,.48),0 0 0 1px rgba(255,255,255,.08)}
    #gpt-panel.gpt-floating .pm-list{padding:8px}
    #gpt-panel.gpt-floating .pm-item{padding:12px;border-radius:14px}
    #gpt-panel.gpt-floating .pm-item-actions{gap:6px;grid-template-columns:repeat(5,minmax(0,1fr))}
    #gpt-panel.gpt-floating .pm-item-actions button,
    #gpt-panel.gpt-floating .pm-add-btn,
    #gpt-panel.gpt-floating .pm-export-btn{
        min-height:36px;
        padding:0 6px;
        gap:0;
        border-radius:10px;
    }
    #gpt-panel.gpt-floating .pm-item-actions button .pm-btn-label,
    #gpt-panel.gpt-floating .pm-add-btn .pm-btn-label,
    #gpt-panel.gpt-floating .pm-export-btn .pm-btn-label{
        display:none;
    }
    #gpt-panel.gpt-floating .pm-item-actions button .pm-btn-ico,
    #gpt-panel.gpt-floating .pm-add-btn .pm-btn-ico,
    #gpt-panel.gpt-floating .pm-export-btn .pm-btn-ico{
        font-size:15px;
    }
    #gpt-panel.gpt-floating .pm-btn-fill,
    #gpt-panel.gpt-floating .pm-btn-fill-send,
    #gpt-panel.gpt-floating .pm-btn-fav,
    #gpt-panel.gpt-floating .pm-btn-edit,
    #gpt-panel.gpt-floating .pm-btn-del{
        width:100%;
        min-width:0;
    }
    #gpt-panel.gpt-floating .pm-add-bar{
        gap:8px;
        align-items:stretch;
    }
    #gpt-panel.gpt-floating .pm-add-btn,
    #gpt-panel.gpt-floating .pm-export-btn{
        min-height:40px;
    }
    #gpt-panel.gpt-floating .pm-add-btn{
        width:auto;
        min-width:0;
        flex:1;
        justify-content:center;
    }
    #gpt-panel.gpt-floating .pm-export-btn{
        flex:0 0 84px;
        width:84px;
        min-width:84px;
        justify-content:center;
    }
    @media (max-width:760px){
        #gpt-panel.gpt-open{width:min(430px,100vw)}
        #gpt-panel.gpt-floating{
            left:12px;
            right:12px;
            bottom:92px;
            width:auto;
            max-height:72vh;
        }
        #gpt-fab{right:16px;bottom:72px}
    }

            `;
        document.head.appendChild(s);
    }

    // ============================================================
    // Section 10: UI - Toast
    // ============================================================
    function toast(m) {
        let t = document.querySelector('.gpt-toast');
        if (!t) { t = document.createElement('div'); t.className = 'gpt-toast'; document.body.appendChild(t); }
        t.textContent = m; t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.remove('show'), 2000);
    }

    function showDialog({ title, body, input, inputValue, confirmText, cancelText, danger }) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'pm-modal-overlay';
            overlay.innerHTML = `
                <div class="pm-modal pm-dialog-modal">
                    <h4>${escHtml(title)}</h4>
                    ${body ? `<div class="pm-dialog-body">${body}</div>` : ''}
                    ${input !== undefined ? `<input class="pm-dialog-input" type="text" value="${escHtml(inputValue || '')}" placeholder="${escHtml(input || '')}" />` : ''}
                    <div class="pm-modal-btns">
                        <button class="pm-btn-cancel" id="pm-dialog-cancel">${cancelText || '取消'}</button>
                        <button class="${danger ? 'pm-btn-danger' : 'pm-btn-save'}" id="pm-dialog-confirm">${confirmText || '确认'}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const inputEl = overlay.querySelector('.pm-dialog-input');
            if (inputEl) setTimeout(() => inputEl.focus(), 50);

            let closed = false;
            const close = (value) => {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKeydown);
                overlay.remove();
                resolve(value);
            };

            const onKeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); close(inputEl ? inputEl.value : true); }
                if (e.key === 'Escape') { e.preventDefault(); close(null); }
            };
            document.addEventListener('keydown', onKeydown);

            overlay.querySelector('#pm-dialog-cancel').addEventListener('click', () => close(null));
            overlay.querySelector('#pm-dialog-confirm').addEventListener('click', () => {
                close(inputEl ? inputEl.value : true);
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
        });
    }

    async function customConfirm(message, { danger } = {}) {
        return showDialog({ title: '确认操作', body: message.replace(/\n/g, '<br>'), confirmText: '确定', cancelText: '取消', danger });
    }

    async function customPrompt(title, placeholder, defaultValue) {
        return showDialog({ title, input: placeholder, inputValue: defaultValue, confirmText: '确定', cancelText: '取消' });
    }

    // ============================================================
    // Section 11: UI - FAB
    // ============================================================
    function createFab() {
        if (document.getElementById(Config.FAB_ID)) return;
        const fab = document.createElement('button');
        fab.id = Config.FAB_ID;
        fab.title = '提示词套件';
        fab.innerHTML = SVG.brush;
        fab.style.display = 'flex';
        fab.onclick = () => togglePanel();
        document.body.appendChild(fab);
    }

    function updateFab() {
        const fab = document.getElementById(Config.FAB_ID);
        if (!fab) return;
        const extracted = allRounds.reduce((s, r) => s + r.prompts.length, 0);
        const old = fab.querySelector('.gpt-badge'); if (old) old.remove();
        if (extracted > 0) {
            const b = document.createElement('span'); b.className = 'gpt-badge'; b.textContent = extracted;
            fab.appendChild(b);
        }
    }

    let panelVisible = false;
    let activeTab = 'extracted';

    function togglePanel(force) {
        const panel = document.getElementById(Config.PANEL_ID);
        if (!panel) return;
        panelVisible = force !== undefined ? force : !panelVisible;
        panel.classList.toggle('gpt-open', panelVisible);
        if (panelVisible) {
            if (activeTab === 'extracted') renderExtractedTab();
            else LibraryUI.render();
        }
    }

    function switchTab(tabName) {
        activeTab = tabName;
        document.querySelectorAll('.gpt-tab').forEach(t => t.classList.toggle('gpt-active', t.dataset.tab === tabName));
        document.querySelectorAll('.gpt-tab-body').forEach(b => b.classList.toggle('gpt-active', b.dataset.tab === tabName));
        if (tabName === 'extracted') renderExtractedTab();
        else LibraryUI.render();
    }

    let panelMode = 'docked'; // 'docked' | 'floating'

    async function togglePanelMode() {
        panelMode = panelMode === 'docked' ? 'floating' : 'docked';
        applyPanelMode();
        await GM_setValue(Config.MODE_KEY, panelMode);
    }

    function applyPanelMode() {
        const panel = document.getElementById(Config.PANEL_ID);
        const btn = document.getElementById('gpt-mode-btn');
        if (!panel) return;

        if (panelMode === 'floating') {
            // Floating: detach from content row, append to body
            if (panel.parentElement !== document.body) {
                document.body.appendChild(panel);
            }
            panel.classList.add('gpt-floating');
        } else {
            // Docked: attach to content row as flex sibling
            const sidebar = document.getElementById('stage-slideover-sidebar');
            const contentRow = sidebar?.parentElement;
            if (contentRow && panel.parentElement !== contentRow) {
                contentRow.appendChild(panel);
            }
            panel.classList.remove('gpt-floating');
        }

        if (btn) {
            btn.innerHTML = panelMode === 'floating' ? SVG.unpin : SVG.pin;
            btn.title = panelMode === 'floating' ? '切换为停靠模式' : '切换为悬浮模式';
            btn.classList.toggle('active', panelMode === 'floating');
        }
    }

    // ============================================================
    // Section 12: UI - Panel Shell
    // ============================================================
    function createPanel() {
        if (document.getElementById(Config.PANEL_ID)) return;
        const panel = document.createElement('div');
        panel.id = Config.PANEL_ID;
        panel.innerHTML = `
            <div class="gpt-tabs">
                <div class="gpt-tab gpt-active" data-tab="extracted">${SVG.brush.replace('width="20" height="20"','width="14" height="14"')} 优化提示词</div>
                <div class="gpt-tab" data-tab="library">${SVG.book} 提示词库</div>
                <button class="gpt-mode-btn" id="gpt-mode-btn" title="切换停靠/悬浮模式">${SVG.pin}</button>
                <button class="gpt-mode-btn" id="gpt-help-btn" title="使用说明">?</button>
            </div>
            <div class="gpt-tab-body gpt-active" data-tab="extracted">
                <div class="rp-hdr">
                    <span>提取结果</span>
                    <div class="rp-hdr-right">
                        <button class="rp-refresh" id="gpt-refresh">${SVG.refresh} 提取</button>
                        <button class="rp-sel-all" id="rp-sel-all">全选</button>
                        <span class="rp-count-badge" id="rp-count">0</span>
                    </div>
                </div>
                <div class="rp-body" id="rp-body"></div>
                <div class="rp-footer">
                    <button class="rp-dl-sel-btn" id="rp-dl-sel" disabled>${SVG.download} 下载选中 (0)</button>
                    <button class="rp-dl-all-btn" id="rp-dl-all">${SVG.download} 全部下载</button>
                </div>
            </div>
            <div class="gpt-tab-body" data-tab="library">
                <div class="pm-search-bar">
                    <input id="pm-search" type="text" placeholder="搜索提示词..." />
                </div>
                <div class="pm-categories" id="pm-categories"></div>
                <div class="pm-list" id="pm-list"></div>
                <div class="pm-add-bar">
                    <button class="pm-add-btn" id="pm-btn-add" title="新增提示词"><span class="pm-btn-ico" aria-hidden="true">➕</span><span class="pm-btn-label">新增提示词</span></button>
                    <button class="pm-export-btn" id="pm-btn-import" title="导入 JSON"><span class="pm-btn-ico" aria-hidden="true">📥</span><span class="pm-btn-label">导入</span></button>
                    <button class="pm-export-btn" id="pm-btn-export" title="导出 JSON"><span class="pm-btn-ico" aria-hidden="true">📤</span><span class="pm-btn-label">导出</span></button>
                </div>
                <input type="file" id="pm-file-input" accept=".json" style="display:none" />
            </div>`;
        // Mount as flex sibling of main content (same row as left sidebar)
        const sidebar = document.getElementById('stage-slideover-sidebar');
        const contentRow = sidebar?.parentElement;
        if (contentRow) {
            contentRow.appendChild(panel);
        } else {
            document.body.appendChild(panel); // fallback
        }

        // Tab switching
        panel.querySelectorAll('.gpt-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        // Close
        document.getElementById('gpt-help-btn').addEventListener('click', () => {
            showDialog({
                title: '使用说明',
                body: `
                    <div style="font-size:13px;line-height:1.8;color:var(--suite-text)">
                    <b>提示词套件</b>用于管理、检索和快速填入提示词到 ChatGPT 输入框。<br><br>
                    <b>基本功能：</b><br>
                    · 点击「只填」将提示词追加到输入框<br>
                    · 点击「填发」将提示词填入并自动发送<br>
                    · 点击「收藏」将提示词置顶<br>
                    · 拖拽卡片可调整顺序<br><br>
                    <b>模板变量：</b><br>
                    在提示词中用 <code>{变量名}</code> 定义占位符。<br>
                    可设置默认值：<code>{变量名='默认值'}</code><br>
                    输入框为空时自动使用默认值，有非引号内容时正常追加。<br><br>
                    <b>传参格式：</b><br>
                    输入框中用引号包裹参数，支持 <code>'</code> <code>"</code> <code>'</code> <code>"</code>，开头结尾必须是同一种引号。<br>
                    参数用 <code>|</code> 分隔。<br><br>
                    <b>示例 1 — 顺序传参：</b><br>
                    提示词：<code>画一幅{主体}在{场景}的{风格}画</code><br>
                    输入框：<code>'猫|花园|水彩'</code><br>
                    结果：<code>画一幅猫在花园的水彩画</code><br><br>
                    <b>示例 2 — 命名传参：</b><br>
                    输入框：<code>'主体=猫|风格=水彩'</code><br>
                    结果：<code>画一幅猫在{场景}的水彩画</code><br><br>
                    <b>示例 3 — 混用传参：</b><br>
                    输入框：<code>'猫|场景=花园|水彩'</code><br>
                    结果：<code>画一幅猫在花园的水彩画</code><br><br>
                    <b>示例 4 — 跳过变量：</b><br>
                    输入框：<code>'猫||水彩'</code><br>
                    结果：<code>画一幅猫在{场景}的水彩画</code>（空位跳过）<br><br>
                    <b>示例 5 — 默认值：</b><br>
                    提示词：<code>画一幅{主体='猫'}在{场景}的{风格}画</code><br>
                    输入框：（空）<br>
                    结果：<code>画一幅猫在{场景}的{风格}画</code><br><br>
                    <b>示例 6 — 空位触发默认值：</b><br>
                    输入框：<code>'|花园|水彩'</code><br>
                    结果：<code>画一幅猫在花园的水彩画</code><br><br>
                    <b>转义：</b> <code>\\|</code> 竖线 · <code>\\\\</code> 反斜杠 · <code>\\n</code> 换行
                    </div>
                `,
                confirmText: '知道了'
            });
        });

        // Mode toggle (docked vs floating)
        document.getElementById('gpt-mode-btn').addEventListener('click', () => togglePanelMode());

        // Extracted tab events
        document.getElementById('gpt-refresh').addEventListener('click', manualFetchPrompts);
        document.getElementById('rp-sel-all').addEventListener('click', toggleSelectAll);
        document.getElementById('rp-dl-sel').addEventListener('click', downloadSelected);
        document.getElementById('rp-dl-all').addEventListener('click', downloadAll);

        // Library tab events
        document.getElementById('pm-btn-add').addEventListener('click', () => LibraryUI.showEditModal());
        document.getElementById('pm-btn-import').addEventListener('click', () => {
            document.getElementById('pm-file-input').click();
        });
        document.getElementById('pm-btn-export').addEventListener('click', () => {
            StorageService.exportJSON(LibraryUI._prompts);
            toast('已导出提示词数据');
        });
        document.getElementById('pm-search').addEventListener('input', e => {
            LibraryUI._searchKeyword = e.target.value;
            LibraryUI.renderList();
        });
        document.getElementById('pm-file-input').addEventListener('change', e => LibraryUI._handleImport(e));
    }

    // ============================================================
    // Section 13: UI - Extracted Tab
    // ============================================================
    function toggleSelectAll() {
        const allP = allRounds.flatMap(r => r.prompts);
        const allSelected = allP.every(p => p.selected);
        allP.forEach(p => p.selected = !allSelected);
        document.querySelectorAll('.rp-cb').forEach(cb => cb.checked = !allSelected);
        document.querySelectorAll('.rp-card').forEach(card => card.classList.toggle('selected', !allSelected));
        document.getElementById('rp-sel-all').textContent = allSelected ? '全选' : '取消全选';
        updateExtractedFooter();
    }

    function updateExtractedFooter() {
        const allP = allRounds.flatMap(r => r.prompts);
        const selCount = allP.filter(p => p.selected).length;
        const btn = document.getElementById('rp-dl-sel');
        if (btn) { btn.disabled = selCount === 0; btn.innerHTML = `${SVG.download} 下载选中 (${selCount})`; }
        const allBtn = document.getElementById('rp-dl-all');
        if (allBtn) allBtn.innerHTML = `${SVG.download} 全部下载 (${allP.length})`;
        const countEl = document.getElementById('rp-count');
        if (countEl) countEl.textContent = allP.length + ' 条';
    }

    async function downloadSelected() {
        const selP = allRounds.flatMap(r => r.prompts).filter(p => p.selected);
        const urls = selP.flatMap(p => p.imageUrls);
        if (!urls.length) return;
        await downloadAsZip(urls, `chatgpt-selected-${urls.length}imgs.zip`);
    }

    async function downloadAll() {
        const urls = allRounds.flatMap(r => r.prompts).flatMap(p => p.imageUrls);
        if (!urls.length) { toast('没有可下载的图片'); return; }
        await downloadAsZip(urls, `chatgpt-all-${urls.length}imgs.zip`);
    }

    function renderExtractedTab() {
        resolveFileIds();
        const body = document.getElementById('rp-body');
        if (!body) return;
        body.innerHTML = '';

        if (allRounds.length === 0) {
            body.innerHTML = '<div class="rp-empty">点击右上角「提取」按钮获取当前对话的优化提示词</div>';
            updateFab(); updateExtractedFooter();
            return;
        }

        let globalIdx = 0;
        for (const round of allRounds) {
            if (!round.prompts.length) continue;
            const div = document.createElement('div');
            div.className = 'rp-round-divider';
            div.innerHTML = `第 ${round.roundIndex} 轮`;
            const roundImgs = round.prompts.flatMap(p => p.imageUrls);
            if (roundImgs.length > 0) {
                const btn = document.createElement('button');
                btn.className = 'rp-round-dl';
                btn.innerHTML = `${SVG.download} 下载 (${roundImgs.length})`;
                btn.onclick = async (e) => { e.stopPropagation(); await downloadAsZip(roundImgs, `chatgpt-round${round.roundIndex}-${roundImgs.length}imgs.zip`); };
                div.appendChild(btn);
            }
            body.appendChild(div);
            for (const item of round.prompts) { globalIdx++; body.appendChild(buildExtractedCard(item, globalIdx)); }
        }
        updateFab(); updateExtractedFooter();
    }

    function buildExtractedCard(item, index) {
        const card = document.createElement('div');
        card.className = 'rp-card' + (item.selected ? ' selected' : '');
        card.dataset.id = item.id;
        const preview = item.prompt.substring(0, 55).replace(/\n/g, ' ') + (item.prompt.length > 55 ? '...' : '');

        let thumbsHtml = '';
        if (item.imageUrls.length > 0) {
            thumbsHtml = '<div class="rp-thumb-strip">';
            item.imageUrls.slice(0, 2).forEach(url => {
                thumbsHtml += `<img class="rp-thumb" src="${escHtml(url)}" loading="lazy" data-preview-url="${escHtml(url)}" onerror="this.style.display='none'">`;
            });
            thumbsHtml += '</div>';
        } else {
            thumbsHtml = `<div class="rp-thumb-ph">${SVG.img}</div>`;
        }

        card.innerHTML = `
            <div class="rp-card-hdr">
                <input type="checkbox" class="rp-cb" ${item.selected ? 'checked' : ''}>
                ${thumbsHtml}
                <div class="rp-card-meta">
                    <span class="rp-tag">#${index || '?'}</span>
                    <span class="rp-preview">${escHtml(preview)}</span>
                </div>
                ${SVG.arrow}
            </div>
            <div class="rp-card-body">
                <div class="rp-txt">${escHtml(item.prompt)}</div>
                <div class="rp-card-acts">
                    <button class="rp-copy-btn">${SVG.copy} 复制</button>
                    <button class="rp-save-btn" title="保存到提示词库">${SVG.save} 存到库</button>
                    ${item.imageUrls.length > 0 ? `<button class="rp-dl-btn">${SVG.download} 下载图片</button>` : ''}
                </div>
            </div>`;

        const hdr = card.querySelector('.rp-card-hdr');
        const cb = card.querySelector('.rp-cb');
        cb.onclick = e => { e.stopPropagation(); item.selected = cb.checked; card.classList.toggle('selected', cb.checked); updateExtractedFooter(); };

        // Thumbnail hover preview
        card.querySelectorAll('.rp-thumb').forEach(thumb => {
            const previewUrl = thumb.dataset.previewUrl;
            let previewEl = null;
            thumb.addEventListener('mouseenter', e => {
                e.stopPropagation(); if (!previewUrl) return;
                if (!previewEl) { previewEl = document.createElement('img'); previewEl.className = 'rp-hover-preview'; previewEl.src = previewUrl; document.body.appendChild(previewEl); }
                const rect = thumb.getBoundingClientRect();
                previewEl.style.top = Math.max(8, rect.top - 96) + 'px';
                previewEl.style.left = Math.max(8, rect.left - 252) + 'px';
                requestAnimationFrame(() => previewEl.classList.add('show'));
            });
            thumb.addEventListener('mouseleave', () => { if (previewEl) previewEl.classList.remove('show'); });
            thumb.addEventListener('click', e => { e.stopPropagation(); if (previewUrl) window.open(previewUrl, '_blank'); });
        });

        hdr.onclick = e => { if (e.target === cb || e.target.classList?.contains('rp-thumb')) return; card.classList.toggle('open'); };

        // Copy
        const copyBtn = card.querySelector('.rp-copy-btn');
        copyBtn.onclick = e => {
            e.stopPropagation();
            navigator.clipboard.writeText(item.prompt).catch(() => {});
            copyBtn.classList.add('ok'); copyBtn.innerHTML = SVG.check + ' 已复制'; toast('已复制到剪贴板');
            setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.innerHTML = SVG.copy + ' 复制'; }, 1500);
        };

        // Save to Library
        const saveBtn = card.querySelector('.rp-save-btn');
        saveBtn.onclick = e => {
            e.stopPropagation();
            LibraryUI.showEditModal(null, {
                title: item.prompt.substring(0, 30).replace(/\n/g, ' '),
                content: item.prompt,
                category: '通用模板',
                tags: ['DALL-E', 'extracted'],
            });
            switchTab('library');
            saveBtn.classList.add('saved'); saveBtn.innerHTML = SVG.check + ' 已存';
            setTimeout(() => { saveBtn.classList.remove('saved'); saveBtn.innerHTML = SVG.save + ' 存到库'; }, 2000);
        };

        // Download image
        const dlBtn = card.querySelector('.rp-dl-btn');
        if (dlBtn) dlBtn.onclick = async e => {
            e.stopPropagation();
            toast(`下载 ${item.imageUrls.length} 张图片...`);
            for (let i = 0; i < item.imageUrls.length; i++) { await downloadImage(item.imageUrls[i], `chatgpt-img-${i+1}.png`); await new Promise(r => setTimeout(r, 300)); }
        };

        return card;
    }

    // ============================================================
    // Section 14: UI - Library Tab
    // ============================================================
    const LibraryUI = {
        _prompts: [],
        _categories: [],
        _searchKeyword: '',
        _activeCategory: '全部',
        _editingId: null,
        _frequentOrder: [],
        _catOrder: [],
        _dragState: null,

        async init() {
            this._prompts = await StorageService.load();
            this._frequentOrder = await StorageService.loadFrequentOrder();
            this._catOrder = await StorageService.loadCategoryOrder();
            this._categories = await StorageService.loadCategories();
        },

        _getCategoryList() {
            // Merge stored categories with any categories found in prompts
            const fromPrompts = new Set(this._prompts.map(p => p.category).filter(Boolean));
            const merged = [...new Set([...this._categories, ...fromPrompts])];
            return merged;
        },

        async _addCategory(name) {
            name = name.trim();
            if (!name) return;
            if (this._categories.includes(name)) { toast('该分类已存在'); return; }
            this._categories.push(name);
            await StorageService.saveCategories(this._categories);
            this.renderCategories();
        },

        async _deleteCategory(name) {
            const promptsInCat = this._prompts.filter(p => p.category === name);
            const count = promptsInCat.length;
            let msg;
            if (count > 0) {
                const titles = promptsInCat.slice(0, 5).map(p => `· ${p.title}`).join('<br>');
                const more = count > 5 ? `<br>...及其他 ${count - 5} 条` : '';
                msg = `确定删除分类「${name}」？<br><br>该分类下的 <b>${count}</b> 条提示词将一并删除：<br>${titles}${more}<br><br>此操作不可撤销。`;
            } else {
                msg = `确定删除分类「${name}」？`;
            }
            if (!await customConfirm(msg, { danger: true })) return;
            this._prompts = this._prompts.filter(p => p.category !== name);
            this._categories = this._categories.filter(c => c !== name);
            await StorageService.save(this._prompts);
            await StorageService.saveCategories(this._categories);
            if (this._activeCategory === name) this._activeCategory = '全部';
            this.renderCategories();
            this.renderList();
            toast(`已删除分类「${name}」及 ${count} 条提示词`);
        },

        render() {
            this.renderCategories();
            this.renderList();
        },

        _getFrequentPrompts(limit = 10) {
            const now = Date.now();
            const scored = this._prompts
                .filter(p => p.usageCount > 0 && p.lastUsedAt)
                .map(p => {
                    const daysSinceUse = (now - new Date(p.lastUsedAt).getTime()) / 86400000;
                    const recencyScore = Math.max(0, 100 - daysSinceUse * 5);
                    const usageScore = Math.min(p.usageCount * 10, 100);
                    return { prompt: p, score: usageScore * 0.6 + recencyScore * 0.4 };
                })
                .sort((a, b) => b.score - a.score);
            return scored.slice(0, limit).map(s => s.prompt);
        },

        renderCategories() {
            const container = document.getElementById('pm-categories');
            if (!container) return;

            // Fixed tabs first, then custom-ordered categories
            const fixedCats = ['常用', '全部'];
            const allCats = this._getCategoryList();
            // Apply saved order to non-fixed categories
            const orderedCats = [];
            for (const c of this._catOrder) {
                if (allCats.includes(c) && !fixedCats.includes(c)) orderedCats.push(c);
            }
            for (const c of allCats) {
                if (!fixedCats.includes(c) && !orderedCats.includes(c)) orderedCats.push(c);
            }

            const renderCat = (c, isDraggable) => {
                const isActive = c === this._activeCategory;
                const canDelete = !fixedCats.includes(c);
                return `<span class="pm-cat-btn${isActive ? ' pm-active' : ''}${isDraggable ? ' pm-cat-draggable' : ''}" data-cat="${c}"><span class="pm-cat-label">${escHtml(c)}${canDelete ? '<button class="pm-cat-del" data-cat="' + c + '" title="删除分类">×</button>' : ''}</span></span>`;
            };

            let html = fixedCats.map(c => renderCat(c, false)).join('');
            html += orderedCats.map(c => renderCat(c, true)).join('');
            html += '<button class="pm-cat-add" id="pm-cat-add" title="新增分类">+ </button>';

            container.innerHTML = html;

            // Click handlers
            container.querySelectorAll('[data-cat]').forEach(btn => {
                if (btn.classList.contains('pm-cat-del')) return;
                btn.addEventListener('click', e => {
                    if (e.target.classList.contains('pm-cat-del')) return;
                    this._activeCategory = btn.dataset.cat;
                    this.renderCategories();
                    this.renderList();
                });
            });

            container.querySelectorAll('.pm-cat-del').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    this._deleteCategory(btn.dataset.cat);
                });
            });

            document.getElementById('pm-cat-add')?.addEventListener('click', async () => {
                const name = await customPrompt('新增分类', '请输入分类名称');
                if (name) this._addCategory(name);
            });

            // Drag reordering for non-fixed categories
            this._bindCatDragEvents(container);
        },

        _bindCatDragEvents(container) {
            if (container._pmCatDragCleanup) container._pmCatDragCleanup();

            const MOVE_THRESHOLD = 6;
            let drag = null;
            let raf = 0;
            let suppressClick = false;

            const clearFrame = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

            const getDraggableItems = () => [...container.querySelectorAll('.pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source)')];

            const setGhostTransform = (dx, dy, ghost = drag?.ghost) => {
                if (!ghost) return;
                ghost.style.setProperty('--pm-cat-dx', `${dx}px`);
                ghost.style.setProperty('--pm-cat-dy', `${dy}px`);
                ghost.style.setProperty('--pm-cat-rotate', `${Math.max(-0.8, Math.min(0.8, dx / 180))}deg`);
            };

            const applyJiggleDelays = () => {
                getDraggableItems().forEach((el, i) => {
                    el.style.setProperty('--pm-cat-jiggle-delay', `${-(i % 5) * 84}ms`);
                });
            };

            const animateLayoutShift = (mutate) => {
                const items = getDraggableItems();
                const first = new Map(items.map(el => [el, el.getBoundingClientRect()]));
                mutate();
                const shifted = [];
                for (const el of items) {
                    if (!el.isConnected) continue;
                    const before = first.get(el);
                    const after = el.getBoundingClientRect();
                    const dx = before.left - after.left;
                    const dy = before.top - after.top;
                    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
                    el.classList.add('pm-cat-shifting');
                    el.style.transition = 'none';
                    el.style.transform = `translate3d(${dx}px,${dy}px,0)`;
                    shifted.push(el);
                }
                if (!shifted.length) return;
                requestAnimationFrame(() => {
                    shifted.forEach(el => {
                        el.style.transition = 'transform .34s cubic-bezier(.16,1,.3,1)';
                        el.style.transform = '';
                    });
                    setTimeout(() => shifted.forEach(el => {
                        el.classList.remove('pm-cat-shifting');
                        el.style.transition = '';
                        el.style.transform = '';
                    }), 380);
                });
            };

            const movePlaceholder = (clientX, clientY) => {
                if (!drag?.placeholder) return;
                const items = getDraggableItems();
                const beforeEl = items.find(el => {
                    const r = el.getBoundingClientRect();
                    const sameRow = clientY >= r.top - 4 && clientY <= r.bottom + 4;
                    return (sameRow && clientX < r.left + r.width / 2) || clientY < r.top + r.height / 2;
                }) || null;
                const currentNext = drag.placeholder.nextElementSibling;
                const addButton = container.querySelector('.pm-cat-add');
                if (beforeEl === currentNext || (!beforeEl && currentNext === addButton)) return;
                animateLayoutShift(() => {
                    if (beforeEl) container.insertBefore(drag.placeholder, beforeEl);
                    else container.insertBefore(drag.placeholder, addButton);
                });
            };

            const startDrag = (e) => {
                const source = drag.item;
                const rect = source.getBoundingClientRect();

                const placeholder = document.createElement('span');
                placeholder.className = 'pm-cat-placeholder';
                placeholder.style.width = `${rect.width}px`;
                placeholder.style.height = `${rect.height}px`;
                source.parentNode.insertBefore(placeholder, source);

                const ghost = source.cloneNode(true);
                ghost.classList.add('pm-cat-lifted');
                ghost.removeAttribute('id');
                ghost.style.left = `${rect.left}px`;
                ghost.style.top = `${rect.top}px`;
                ghost.style.width = `${rect.width}px`;
                ghost.style.height = `${rect.height}px`;
                ghost.style.transition = 'box-shadow .18s ease,border-color .18s ease';
                document.body.appendChild(ghost);

                source.classList.add('pm-cat-source');

                drag.rect = rect;
                drag.ghost = ghost;
                drag.placeholder = placeholder;
                drag.started = true;
                suppressClick = true;
                drag.offsetX = e.clientX - rect.left;
                drag.offsetY = e.clientY - rect.top;

                setGhostTransform(0, 0);
                container.classList.add('pm-cat-reordering');
                applyJiggleDelays();
            };

            const onPointerDown = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (e.target.closest('button,input,textarea,select')) return;
                const item = e.target.closest('.pm-cat-btn.pm-cat-draggable');
                if (!item || !container.contains(item)) return;
                drag = {
                    item,
                    ghost: null,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    rect: item.getBoundingClientRect(),
                    started: false,
                    placeholder: null,
                    offsetX: 0,
                    offsetY: 0,
                };
                item.setPointerCapture?.(e.pointerId);
            };

            const onPointerMove = (e) => {
                if (!drag) return;
                const dx = e.clientX - drag.startX;
                const dy = e.clientY - drag.startY;
                if (!drag.started) {
                    if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
                    startDrag(e);
                }
                e.preventDefault();
                clearFrame();
                raf = requestAnimationFrame(() => {
                    setGhostTransform(dx, dy);
                    movePlaceholder(e.clientX, e.clientY);
                });
            };

            const waitForTransition = (el, propertyName, fallback = 240) => new Promise(resolve => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    el.removeEventListener('transitionend', onEnd);
                    resolve();
                };
                const onEnd = (ev) => {
                    if (ev.target === el && (!propertyName || ev.propertyName === propertyName)) finish();
                };
                el.addEventListener('transitionend', onEnd);
                setTimeout(finish, fallback);
            });

            const finishDrag = async (shouldSave = true) => {
                if (!drag) return;
                clearFrame();
                const state = drag;
                drag = null;

                const source = state.item;
                try { source.releasePointerCapture?.(state.pointerId); } catch(e) {}

                if (!state.started) return;

                const ghost = state.ghost;
                const placeholder = state.placeholder;
                const targetRect = placeholder.getBoundingClientRect();
                const dx = targetRect.left - state.rect.left;
                const dy = targetRect.top - state.rect.top;

                ghost.style.transition = 'transform .19s cubic-bezier(.2,.9,.2,1),box-shadow .19s ease,opacity .16s ease';
                setGhostTransform(dx, dy, ghost);

                await waitForTransition(ghost, 'transform', 230);

                const firstRects = new Map(getDraggableItems().map(el => [el, el.getBoundingClientRect()]));
                placeholder.parentNode.insertBefore(source, placeholder);
                source.classList.remove('pm-cat-source');
                source.classList.add('pm-cat-drop-pop');
                placeholder.remove();

                requestAnimationFrame(() => {
                    for (const [el, before] of firstRects) {
                        if (!el.isConnected || el === source) continue;
                        const after = el.getBoundingClientRect();
                        const shiftX = before.left - after.left;
                        const shiftY = before.top - after.top;
                        if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) continue;
                        el.style.transition = 'none';
                        el.style.transform = `translate3d(${shiftX}px,${shiftY}px,0)`;
                        requestAnimationFrame(() => {
                            el.style.transition = 'transform .28s cubic-bezier(.16,1,.3,1)';
                            el.style.transform = '';
                        });
                    }
                    requestAnimationFrame(() => ghost.remove());
                });
                setTimeout(() => {
                    container.classList.remove('pm-cat-reordering');
                    getDraggableItems().forEach(el => {
                        el.style.removeProperty('--pm-cat-jiggle-delay');
                        el.style.transform = '';
                        el.style.transition = '';
                        el.classList.remove('pm-cat-shifting');
                    });
                    source.classList.remove('pm-cat-drop-pop');
                }, 360);

                if (shouldSave) {
                    const newOrder = [...container.querySelectorAll('.pm-cat-btn.pm-cat-draggable:not(.pm-cat-lifted):not(.pm-cat-source)')].map(el => el.dataset.cat);
                    const saveOrder = async () => {
                        this._catOrder = newOrder;
                        await StorageService.saveCategoryOrder(newOrder);
                    };
                    if (window.requestIdleCallback) window.requestIdleCallback(() => saveOrder().catch(e => log('保存分类排序失败:', e)), { timeout: 1000 });
                    else setTimeout(() => saveOrder().catch(e => log('保存分类排序失败:', e)), 260);
                }
                setTimeout(() => { suppressClick = false; }, 0);
            };

            const onPointerUp = () => finishDrag(true);
            const onPointerCancel = () => finishDrag(false);
            const onClickCapture = (e) => {
                if (!suppressClick) return;
                suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
            };

            container.addEventListener('pointerdown', onPointerDown);
            container.addEventListener('click', onClickCapture, true);
            window.addEventListener('pointermove', onPointerMove, { passive: false });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerCancel);

            container._pmCatDragCleanup = () => {
                clearFrame();
                if (drag?.ghost) drag.ghost.remove();
                if (drag?.placeholder) drag.placeholder.remove();
                if (drag?.item) drag.item.classList.remove('pm-cat-source');
                drag = null;
                suppressClick = false;
                container.classList.remove('pm-cat-reordering');
                getDraggableItems().forEach(el => {
                    el.style.removeProperty('--pm-cat-jiggle-delay');
                    el.style.transform = '';
                    el.style.transition = '';
                    el.classList.remove('pm-cat-shifting');
                });
                container.removeEventListener('pointerdown', onPointerDown);
                container.removeEventListener('click', onClickCapture, true);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerCancel);
            };
        },

        renderList() {
            const container = document.getElementById('pm-list');
            if (!container) return;
            let filtered;
            if (this._activeCategory === '常用') {
                filtered = this._getFrequentPrompts(10);
                filtered = PromptService.search(this._searchKeyword, filtered);
                // Apply frequentOrder if available
                if (this._frequentOrder.length > 0) {
                    const orderMap = new Map(this._frequentOrder.map((id, i) => [id, i]));
                    filtered.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
                }
            } else {
                filtered = PromptService.filterByCategory(this._activeCategory, this._prompts);
                filtered = PromptService.search(this._searchKeyword, filtered);
                filtered.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
            }

            if (filtered.length === 0) {
                container.innerHTML = `<div class="pm-empty">${this._prompts.length === 0 ? '还没有提示词，点击下方按钮添加' : '没有匹配的提示词'}</div>`;
                return;
            }

            // Split into favorites and normal groups
            const favs = filtered.filter(p => p.favorite);
            const normals = filtered.filter(p => !p.favorite);

            const renderItem = p => `
                <div class="pm-item" data-id="${p.id}">
                    <div class="pm-item-inner">
                        <div class="pm-item-title">
                            ${p.favorite ? '<span class="pm-fav">★</span>' : ''}
                            <span>${escHtml(p.title)}</span>
                            <span class="pm-item-title-tags">${(p.tags || []).map(t => `<span class="pm-tag">${escHtml(t)}</span>`).join('')}</span>
                        </div>
                        <div class="pm-item-preview">${escHtml(p.content)}</div>
                        <div class="pm-item-meta">
                            ${(() => { const vars = parseTemplate(p.content); return vars.length > 0 ? `<div class="pm-item-tags">${vars.map(v => { const def = v.defaultVal; const label = def ? (def.length > 5 ? v.name + "='" + def.slice(0, 5) + "…'" : v.name + "='" + def + "'") : v.name; return `<span class="pm-tag pm-var-tag">{${escHtml(label)}}</span>`; }).join('')}</div>` : ''; })()}
                            <div class="pm-item-actions">
                                <button class="pm-btn-fill" data-id="${p.id}" title="追加到输入框"><span class="pm-btn-ico" aria-hidden="true">⌨️</span><span class="pm-btn-label">只填</span></button>
                                <button class="pm-btn-fill-send" data-id="${p.id}" title="填入并发送"><span class="pm-btn-ico" aria-hidden="true">📨</span><span class="pm-btn-label">填发</span></button>
                                <button class="pm-btn-fav" data-id="${p.id}" title="${p.favorite ? '取消收藏' : '收藏'}"><span class="pm-btn-ico" aria-hidden="true">${p.favorite ? '⭐' : '☆'}</span><span class="pm-btn-label">收藏</span></button>
                                <button class="pm-btn-edit" data-id="${p.id}" title="编辑"><span class="pm-btn-ico" aria-hidden="true">✏️</span><span class="pm-btn-label">编辑</span></button>
                                <button class="pm-btn-del" data-id="${p.id}" title="删除"><span class="pm-btn-ico" aria-hidden="true">🗑️</span><span class="pm-btn-label">删除</span></button>
                            </div>
                        </div>
                    </div>
                </div>`;

            const favHtml = favs.map(renderItem).join('');
            const dividerHtml = favs.length > 0 && normals.length > 0
                ? '<div class="pm-fav-divider" data-type="divider"><span>收藏</span></div>'
                : '';
            const normalHtml = normals.map(renderItem).join('');

            container.innerHTML = favHtml + dividerHtml + normalHtml;

            container.querySelectorAll('.pm-btn-fill').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillPrompt(btn.dataset.id); }));
            container.querySelectorAll('.pm-btn-fill-send').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._fillAndSendPrompt(btn.dataset.id); }));
            container.querySelectorAll('.pm-btn-edit').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this.showEditModal(btn.dataset.id); }));
            container.querySelectorAll('.pm-btn-del').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._deletePrompt(btn.dataset.id); }));
            container.querySelectorAll('.pm-btn-fav').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); this._toggleFavorite(btn.dataset.id); }));
            this._bindDragEvents(container);
        },

        _bindDragEvents(container) {
            // Pointer-based sorting with a fixed visual clone.
            // The original card stays out of the animated layer and is only
            // swapped back after the ghost lands, avoiding the fixed->flow hitch.
            if (container._pmDragCleanup) container._pmDragCleanup();

            const MOVE_THRESHOLD = 6;
            let drag = null;
            let raf = 0;
            let lastClientY = 0;

            const clearFrame = () => {
                if (raf) cancelAnimationFrame(raf);
                raf = 0;
            };

            const getListItems = () => [...container.querySelectorAll('.pm-item:not(.pm-lifted):not(.pm-drag-source)')];
            const getDivider = () => container.querySelector('.pm-fav-divider');

            const setGhostTransform = (dx, dy, ghost = drag?.ghost) => {
                if (!ghost) return;
                ghost.style.setProperty('--pm-drag-x', `${dx}px`);
                ghost.style.setProperty('--pm-drag-y', `${dy}px`);
                ghost.style.setProperty('--pm-drag-rotate', `${Math.max(-0.95, Math.min(0.95, dx / 155))}deg`);
            };

            const applyJiggleDelays = () => {
                getListItems().forEach((el, i) => {
                    el.style.setProperty('--pm-jiggle-delay', `${-(i % 5) * 84}ms`);
                });
            };

            const animateLayoutShift = (mutate) => {
                const items = getListItems();
                const first = new Map(items.map(el => [el, el.getBoundingClientRect()]));
                mutate();
                const shifted = [];
                for (const el of items) {
                    if (!el.isConnected) continue;
                    const before = first.get(el);
                    const after = el.getBoundingClientRect();
                    const dx = before.left - after.left;
                    const dy = before.top - after.top;
                    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
                    el.classList.add('pm-shifting');
                    el.style.transition = 'none';
                    el.style.transform = `translate3d(${dx}px,${dy}px,0)`;
                    shifted.push(el);
                }
                if (!shifted.length) return;
                requestAnimationFrame(() => {
                    shifted.forEach(el => {
                        el.style.transition = 'transform .34s cubic-bezier(.16,1,.3,1),box-shadow .18s ease,border-color .18s ease,background .18s ease';
                        el.style.transform = '';
                    });
                    setTimeout(() => {
                        shifted.forEach(el => {
                            el.classList.remove('pm-shifting');
                            el.style.transition = '';
                            el.style.transform = '';
                        });
                    }, 380);
                });
            };

            const movePlaceholder = (clientY) => {
                if (!drag?.placeholder) return;
                const items = getListItems();
                const divider = getDivider();
                const beforeEl = items.find(el => {
                    const r = el.getBoundingClientRect();
                    return clientY < r.top + r.height / 2;
                }) || null;
                // Never insert before the divider (favorites stay on top)
                if (divider && beforeEl === divider) return;
                const currentNext = drag.placeholder.nextElementSibling;
                if (beforeEl === currentNext || (!beforeEl && drag.placeholder === container.lastElementChild)) return;
                animateLayoutShift(() => {
                    if (beforeEl) container.insertBefore(drag.placeholder, beforeEl);
                    else container.appendChild(drag.placeholder);
                });
            };

            const autoScroll = (clientY) => {
                const r = container.getBoundingClientRect();
                const edge = 46;
                if (clientY < r.top + edge) container.scrollTop -= Math.round((r.top + edge - clientY) / 4) + 4;
                else if (clientY > r.bottom - edge) container.scrollTop += Math.round((clientY - (r.bottom - edge)) / 4) + 4;
            };

            const startDrag = (e) => {
                const source = drag.item;
                const rect = source.getBoundingClientRect();
                const cs = getComputedStyle(source);

                const placeholder = document.createElement('div');
                placeholder.className = 'pm-drag-placeholder';
                placeholder.style.height = `${rect.height}px`;
                placeholder.style.marginBottom = cs.marginBottom;
                source.parentNode.insertBefore(placeholder, source);

                const ghost = source.cloneNode(true);
                ghost.classList.add('pm-lifted');
                ghost.removeAttribute('id');
                ghost.style.left = `${rect.left}px`;
                ghost.style.top = `${rect.top}px`;
                ghost.style.width = `${rect.width}px`;
                ghost.style.height = `${rect.height}px`;
                ghost.style.transition = 'box-shadow .18s ease,border-color .18s ease,opacity .18s ease';
                document.body.appendChild(ghost);

                // Hide the real card after the placeholder is in place. The visual card
                // is now the ghost, so release will not need to convert fixed -> normal flow.
                source.classList.add('pm-drag-source');

                drag.rect = rect;
                drag.ghost = ghost;
                drag.placeholder = placeholder;
                drag.started = true;
                drag.offsetX = e.clientX - rect.left;
                drag.offsetY = e.clientY - rect.top;
                lastClientY = e.clientY;

                setGhostTransform(0, 0);
                container.classList.add('pm-reordering');
                applyJiggleDelays();
            };

            const onPointerDown = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                if (e.target.closest('button,input,textarea,select,a,[contenteditable="true"]')) return;
                const item = e.target.closest('.pm-item');
                if (!item || !container.contains(item)) return;
                drag = {
                    item,
                    ghost: null,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    rect: item.getBoundingClientRect(),
                    started: false,
                    placeholder: null,
                    offsetX: 0,
                    offsetY: 0,
                };
                item.setPointerCapture?.(e.pointerId);
            };

            const onPointerMove = (e) => {
                if (!drag) return;
                const dx = e.clientX - drag.startX;
                const dy = e.clientY - drag.startY;
                lastClientY = e.clientY;
                if (!drag.started) {
                    if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
                    startDrag(e);
                }
                e.preventDefault();
                clearFrame();
                raf = requestAnimationFrame(() => {
                    setGhostTransform(dx, dy);
                    movePlaceholder(lastClientY);
                    autoScroll(lastClientY);
                });
            };

            const waitForTransition = (el, propertyName, fallback = 240) => new Promise(resolve => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    el.removeEventListener('transitionend', onEnd);
                    resolve();
                };
                const onEnd = (ev) => {
                    if (ev.target === el && (!propertyName || ev.propertyName === propertyName)) finish();
                };
                el.addEventListener('transitionend', onEnd);
                setTimeout(finish, fallback);
            });

            const finishDrag = async (shouldSave = true) => {
                if (!drag) return;
                clearFrame();
                const state = drag;
                drag = null;

                const source = state.item;
                try { source.releasePointerCapture?.(state.pointerId); } catch(e) {}

                if (!state.started) return;

                const ghost = state.ghost;
                const placeholder = state.placeholder;
                const targetRect = placeholder.getBoundingClientRect();
                const dx = targetRect.left - state.rect.left;
                const dy = targetRect.top - state.rect.top;

                ghost.classList.add('pm-dropping');
                ghost.style.transition = 'transform .19s cubic-bezier(.2,.9,.2,1),box-shadow .19s ease,border-color .19s ease,opacity .16s ease';
                setGhostTransform(dx, dy, ghost);

                await waitForTransition(ghost, 'transform', 230);

                // Swap the real card into the placeholder while the ghost is still above it.
                // This makes the visual handoff effectively invisible and removes the release hitch.
                const firstRects = new Map(getListItems().map(el => [el, el.getBoundingClientRect()]));
                placeholder.parentNode.insertBefore(source, placeholder);
                source.classList.remove('pm-drag-source');
                source.classList.add('pm-drop-pop');
                placeholder.remove();

                requestAnimationFrame(() => {
                    for (const [el, before] of firstRects) {
                        if (!el.isConnected || el === source) continue;
                        const after = el.getBoundingClientRect();
                        const shiftX = before.left - after.left;
                        const shiftY = before.top - after.top;
                        if (Math.abs(shiftX) < .5 && Math.abs(shiftY) < .5) continue;
                        el.style.transition = 'none';
                        el.style.transform = `translate3d(${shiftX}px,${shiftY}px,0)`;
                        requestAnimationFrame(() => {
                            el.style.transition = 'transform .28s cubic-bezier(.16,1,.3,1)';
                            el.style.transform = '';
                        });
                    }
                    requestAnimationFrame(() => ghost.remove());
                });

                // Clean up after the visual handoff. Keep the jiggle for a tiny moment,
                // so the whole group settles instead of stopping sharply on mouseup.
                setTimeout(() => {
                    container.classList.remove('pm-reordering');
                    getListItems().forEach(el => {
                        el.style.removeProperty('--pm-jiggle-delay');
                        el.style.transform = '';
                        el.style.transition = '';
                        el.classList.remove('pm-shifting');
                    });
                }, 150);
                setTimeout(() => source.classList.remove('pm-drop-pop'), 360);

                if (shouldSave) {
                    const newOrder = [...container.querySelectorAll('.pm-item:not(.pm-lifted):not(.pm-drag-source)')].map(el => el.dataset.id);
                    const draggedId = source.dataset.id;
                    const saveOrder = () => this._saveNewOrder(newOrder, draggedId, container).catch(e => log('保存排序失败:', e));
                    if (window.requestIdleCallback) window.requestIdleCallback(saveOrder, { timeout: 1000 });
                    else setTimeout(saveOrder, 260);
                }
            };

            const onPointerUp = () => finishDrag(true);
            const onPointerCancel = () => finishDrag(false);

            container.addEventListener('pointerdown', onPointerDown);
            window.addEventListener('pointermove', onPointerMove, { passive: false });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerCancel);

            container._pmDragCleanup = () => {
                clearFrame();
                if (drag?.ghost) drag.ghost.remove();
                if (drag?.placeholder) drag.placeholder.remove();
                if (drag?.item) drag.item.classList.remove('pm-drag-source');
                drag = null;
                container.classList.remove('pm-reordering');
                getListItems().forEach(el => {
                    el.style.removeProperty('--pm-jiggle-delay');
                    el.style.transform = '';
                    el.style.transition = '';
                    el.classList.remove('pm-shifting');
                });
                container.removeEventListener('pointerdown', onPointerDown);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerCancel);
            };
        },

        async _saveNewOrder(newOrder, draggedId, container) {
            if (this._activeCategory === '常用') {
                this._frequentOrder = newOrder;
                await StorageService.saveFrequentOrder(newOrder);
                this.renderList();
                return;
            }

            // Check if the dragged item crossed zones
            const draggedPrompt = this._prompts.find(p => p.id === draggedId);
            const crossedZone = draggedPrompt && (() => {
                // Find where the item ended up in the DOM order
                const domIdx = newOrder.indexOf(draggedId);
                const favCount = newOrder.filter(id => {
                    const p = this._prompts.find(pp => pp.id === id);
                    return p?.favorite;
                }).length;
                // If favorite ended up in normal zone, or normal ended up in favorite zone
                if (draggedPrompt.favorite && domIdx >= favCount) return true;
                if (!draggedPrompt.favorite && domIdx < favCount) return true;
                return false;
            })();

            // Capture position before re-render if crossing zone
            let oldRect = null;
            if (crossedZone && container) {
                const el = container.querySelector(`[data-id="${draggedId}"]`);
                if (el) oldRect = el.getBoundingClientRect();
            }

            // Separate favorites and normals
            const favIds = [];
            const normalIds = [];
            for (const id of newOrder) {
                const p = this._prompts.find(p => p.id === id);
                if (!p) continue;
                if (p.favorite) favIds.push(id);
                else normalIds.push(id);
            }
            favIds.forEach((id, i) => {
                const p = this._prompts.find(p => p.id === id);
                if (p) p.sortOrder = i;
            });
            normalIds.forEach((id, i) => {
                const p = this._prompts.find(p => p.id === id);
                if (p) p.sortOrder = i + 10000;
            });
            await StorageService.save(this._prompts);
            this.renderList();

            // Animate the zone crossing
            if (crossedZone && oldRect && container) {
                const newEl = container.querySelector(`[data-id="${draggedId}"]`);
                if (newEl) {
                    const newRect = newEl.getBoundingClientRect();
                    const dx = oldRect.left - newRect.left;
                    const dy = oldRect.top - newRect.top;
                    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                        newEl.style.transition = 'none';
                        newEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
                        newEl.style.zIndex = '10';
                        newEl.style.boxShadow = '0 8px 24px rgba(0,0,0,.15)';
                        requestAnimationFrame(() => {
                            newEl.style.transition = 'transform .4s cubic-bezier(.16,1,.3,1), box-shadow .4s ease';
                            newEl.style.transform = '';
                            newEl.style.boxShadow = '';
                            setTimeout(() => {
                                newEl.style.transition = '';
                                newEl.style.transform = '';
                                newEl.style.zIndex = '';
                                newEl.style.boxShadow = '';
                            }, 450);
                        });
                    }
                }
            }
        },

        async _reorderPrompts(draggedId, targetId) {
            if (this._activeCategory === '常用') {
                // Reorder in frequentOrder
                const order = [...this._frequentOrder];
                const fromIdx = order.indexOf(draggedId);
                const toIdx = order.indexOf(targetId);
                if (fromIdx === -1 || toIdx === -1) return;
                order.splice(fromIdx, 1);
                order.splice(toIdx, 0, draggedId);
                this._frequentOrder = order;
                await StorageService.saveFrequentOrder(order);
            } else {
                // Reorder within current category
                const filtered = PromptService.filterByCategory(this._activeCategory, this._prompts);
                filtered.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
                const fromIdx = filtered.findIndex(p => p.id === draggedId);
                const toIdx = filtered.findIndex(p => p.id === targetId);
                if (fromIdx === -1 || toIdx === -1) return;
                const [moved] = filtered.splice(fromIdx, 1);
                filtered.splice(toIdx, 0, moved);
                filtered.forEach((p, i) => { p.sortOrder = i; });
                await StorageService.save(this._prompts);
            }
            this.renderList();
        },

        async _fillPrompt(id) {
            const prompt = this._prompts.find(p => p.id === id);
            if (!prompt) return;
            let content = prompt.content;
            let replaced = false;
            const vars = parseTemplate(content);
            if (vars.length > 0) {
                const args = readArgsFromEditor();
                if (args) {
                    if (args.error) { toast(args.error); return; }
                    const result = resolveArgs(vars, args.tokens);
                    if (result.errors.length > 0) { toast(result.errors[0]); return; }
                    content = fillTemplate(content, vars, result);
                    replaced = true;
                    clearEditor();
                } else {
                    // No args in input box — apply defaults only
                    content = fillTemplate(content, vars, { values: {}, skipped: new Set(), errors: [] });
                }
            }
            const success = SiteAdapter.insertText(content, replaced ? 'replace' : 'append');
            if (success) {
                prompt.usageCount = (prompt.usageCount || 0) + 1;
                prompt.lastUsedAt = new Date().toISOString();
                await StorageService.save(this._prompts);
                this.renderList();
                toast(replaced ? '已替换变量并追加到输入框' : '已追加到输入框，仍需手动发送');
            } else {
                toast('未找到输入框，请点击 ChatGPT 输入区域后再试');
            }
        },

        async _fillAndSendPrompt(id) {
            const prompt = this._prompts.find(p => p.id === id);
            if (!prompt) return;
            let content = prompt.content;
            const vars = parseTemplate(content);
            if (vars.length > 0) {
                const args = readArgsFromEditor();
                if (args) {
                    if (args.error) { toast(args.error); return; }
                    const result = resolveArgs(vars, args.tokens);
                    if (result.errors.length > 0) { toast(result.errors[0]); return; }
                    content = fillTemplate(content, vars, result);
                    clearEditor();
                } else {
                    content = fillTemplate(content, vars, { values: {}, skipped: new Set(), errors: [] });
                }
            }
            const success = SiteAdapter.insertText(content, 'replace');
            if (!success) { toast('未找到输入框，请点击 ChatGPT 输入区域后再试'); return; }
            prompt.usageCount = (prompt.usageCount || 0) + 1;
            prompt.lastUsedAt = new Date().toISOString();
            await StorageService.save(this._prompts);
            this.renderList();
            toast('已填入，等待发送...');
            // Poll until send button is ready (max 45s)
            for (let i = 0; i < 225; i++) {
                await new Promise(r => setTimeout(r, 200));
                const sendBtn = document.querySelector('.composer-submit-button-color');
                if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
            }
            toast('发送按钮未就绪，请手动点击发送');
        },

        async _deletePrompt(id) {
            const prompt = this._prompts.find(p => p.id === id);
            if (!prompt) return;
            if (!await customConfirm(`确定删除「${prompt.title}」？`, { danger: true })) return;
            this._prompts = this._prompts.filter(p => p.id !== id);
            await StorageService.save(this._prompts);
            this.renderList();
            this.renderCategories();
            toast('已删除');
        },

        async _toggleFavorite(id) {
            const prompt = this._prompts.find(p => p.id === id);
            if (!prompt) return;
            prompt.favorite = !prompt.favorite;
            await StorageService.save(this._prompts);
            this.renderList();
        },

        async _handleImport(e) {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = '';
            try {
                const imported = await StorageService.importJSON(file);
                const existingMap = new Map(this._prompts.map(p => [p.id, p]));
                const toAdd = [];
                const conflicts = [];
                for (const imp of imported) {
                    const local = existingMap.get(imp.id);
                    if (!local) {
                        toAdd.push(imp);
                    } else {
                        const same = local.content === imp.content && local.updatedAt === imp.updatedAt;
                        if (same) continue;
                        conflicts.push({ local, imported: imp });
                    }
                }
                if (conflicts.length === 0) {
                    this._prompts.push(...toAdd);
                    await StorageService.save(this._prompts);
                    this.renderList();
                    toast(`已导入 ${toAdd.length} 条提示词`);
                    return;
                }
                this._showImportConflictDialog(toAdd, conflicts);
            } catch(err) { toast('导入失败：' + err.message); }
        },

        _showImportConflictDialog(toAdd, conflicts) {
            const overlay = document.createElement('div');
            overlay.className = 'pm-modal-overlay';
            const resolutions = new Map();
            let mode = null;

            // Single render function
            const renderList = () => {
                const listEl = overlay.querySelector('#pm-conflict-list');
                if (!listEl) return;
                listEl.innerHTML = conflicts.map((c, i) => {
                    const localTime = new Date(c.local.updatedAt).toLocaleString('zh-CN');
                    const importTime = new Date(c.imported.updatedAt).toLocaleString('zh-CN');
                    const localNewer = new Date(c.local.updatedAt) >= new Date(c.imported.updatedAt);
                    const current = resolutions.get(c.imported.id);
                    return `<div class="pm-conflict-item" data-idx="${i}">
                        <div class="pm-conflict-title">${escHtml(c.imported.title || c.local.title)}</div>
                        <div class="pm-conflict-id">ID: ${escHtml(c.imported.id)}</div>
                        <div class="pm-conflict-compare">
                            <div class="pm-conflict-side pm-conflict-local">
                                <div class="pm-conflict-side-header">
                                    <span class="pm-conflict-side-label">本地</span>
                                    <span class="pm-conflict-side-time ${localNewer ? 'pm-conflict-newer' : ''}">${localTime}</span>
                                </div>
                                <div class="pm-conflict-side-content">${escHtml(c.local.content)}</div>
                            </div>
                            <div class="pm-conflict-side pm-conflict-imported">
                                <div class="pm-conflict-side-header">
                                    <span class="pm-conflict-side-label">导入</span>
                                    <span class="pm-conflict-side-time ${!localNewer ? 'pm-conflict-newer' : ''}">${importTime}</span>
                                </div>
                                <div class="pm-conflict-side-content">${escHtml(c.imported.content)}</div>
                            </div>
                        </div>
                        <div class="pm-conflict-actions">
                            <button class="pm-conflict-btn${current === 'skip' ? ' pm-conflict-active' : ''}" data-idx="${i}" data-action="skip">保留本地</button>
                            <button class="pm-conflict-btn${current === 'replace' ? ' pm-conflict-active' : ''}" data-idx="${i}" data-action="replace">使用导入</button>
                        </div>
                    </div>`;
                }).join('');
                // Bind item buttons after render
                listEl.querySelectorAll('.pm-conflict-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const idx = parseInt(btn.dataset.idx);
                        resolutions.set(conflicts[idx].imported.id, btn.dataset.action);
                        renderList();
                    });
                });
            };

            overlay.innerHTML = `
                <div class="pm-modal pm-conflict-modal">
                    <h4>导入冲突（${conflicts.length} 条）</h4>
                    <div class="pm-conflict-desc">以下提示词 ID 相同但内容不同，请选择处理方式：</div>
                    <div class="pm-conflict-global">
                        <button class="pm-conflict-global-btn" data-mode="replace">全部替换</button>
                        <button class="pm-conflict-global-btn" data-mode="newest">按时间最新</button>
                        <button class="pm-conflict-global-btn" data-mode="skip">全部跳过</button>
                    </div>
                    <div class="pm-conflict-list" id="pm-conflict-list"></div>
                    <div class="pm-modal-btns">
                        <button class="pm-btn-cancel" id="pm-conflict-cancel">取消</button>
                        <button class="pm-btn-save" id="pm-conflict-confirm">确认导入</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            renderList();

            // Global buttons
            overlay.querySelectorAll('.pm-conflict-global-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    mode = btn.dataset.mode;
                    overlay.querySelectorAll('.pm-conflict-global-btn').forEach(b => b.classList.remove('pm-conflict-active'));
                    btn.classList.add('pm-conflict-active');
                    if (mode === 'replace') {
                        conflicts.forEach(c => resolutions.set(c.imported.id, 'replace'));
                    } else if (mode === 'skip') {
                        conflicts.forEach(c => resolutions.set(c.imported.id, 'skip'));
                    } else if (mode === 'newest') {
                        conflicts.forEach(c => {
                            resolutions.set(c.imported.id, new Date(c.imported.updatedAt) > new Date(c.local.updatedAt) ? 'replace' : 'skip');
                        });
                    }
                    renderList();
                });
            });

            overlay.querySelector('#pm-conflict-cancel').addEventListener('click', () => overlay.remove());
            overlay.querySelector('#pm-conflict-confirm').addEventListener('click', async () => {
                if (!mode) {
                    toast('请先选择处理方式');
                    return;
                }
                // Apply resolutions
                for (const [id, action] of resolutions) {
                    if (action === 'replace') {
                        const imp = conflicts.find(c => c.imported.id === id)?.imported;
                        if (imp) {
                            const idx = this._prompts.findIndex(p => p.id === id);
                            if (idx !== -1) this._prompts[idx] = imp;
                        }
                    }
                }
                this._prompts.push(...toAdd);
                await StorageService.save(this._prompts);
                overlay.remove();
                this.renderList();
                const replaced = [...resolutions.values()].filter(a => a === 'replace').length;
                toast(`已导入 ${toAdd.length} 条新增，${replaced} 条替换`);
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        },

        showEditModal(id, prefill) {
            this._editingId = id || null;
            const prompt = id ? this._prompts.find(p => p.id === id) : null;
            const defaultCategory = (this._activeCategory !== '全部' && this._activeCategory !== '常用') ? this._activeCategory : '通用模板';
            const data = prompt || prefill || { category: defaultCategory };
            const modalCategories = [...new Set([...this._getCategoryList(), data.category || defaultCategory].filter(Boolean))];
            const selectedCategory = modalCategories.includes(data.category) ? data.category : (modalCategories[0] || defaultCategory);

            const overlay = document.createElement('div');
            overlay.className = 'pm-modal-overlay';
            overlay.innerHTML = `
                <div class="pm-modal">
                    <h4>${prompt ? '编辑提示词' : '新增提示词'}</h4>
                    <label>标题</label>
                    <input id="pm-edit-title" type="text" value="${escHtml(data.title || '')}" placeholder="给提示词起个名字" />
                    <label>内容</label>
                    <textarea id="pm-edit-content" placeholder="输入提示词内容...">${escHtml(data.content || '')}</textarea>
                    <div style="margin:-8px 0 12px;font-size:11px;color:var(--suite-text-muted)">使用 {变量名} 定义占位符，{变量名='默认值'} 设置默认值。传参格式：'参数1|参数2' 或 "参数1|参数2"，空位跳过</div>
                    <label>分类</label>
                    <select id="pm-edit-category" class="pm-select-native" aria-hidden="true" tabindex="-1">
                        ${modalCategories.map(c => `<option value="${escAttr(c)}"${selectedCategory === c ? ' selected' : ''}>${escHtml(c)}</option>`).join('')}
                    </select>
                    <div class="pm-select" data-for="pm-edit-category">
                        <button type="button" class="pm-select-trigger" aria-haspopup="listbox" aria-expanded="false">
                            <span class="pm-select-value">${escHtml(selectedCategory)}</span>
                            <span class="pm-select-arrow" aria-hidden="true">⌄</span>
                        </button>
                        <div class="pm-select-menu" role="listbox" tabindex="-1">
                            ${modalCategories.map(c => `
                                <button type="button" class="pm-select-option${selectedCategory === c ? ' pm-selected' : ''}" role="option" aria-selected="${selectedCategory === c ? 'true' : 'false'}" data-value="${escAttr(c)}">
                                    <span>${escHtml(c)}</span><span class="pm-select-check" aria-hidden="true">✓</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    <label>标签（逗号分隔）</label>
                    <input id="pm-edit-tags" type="text" value="${(data.tags || []).join(', ')}" placeholder="标签1, 标签2" />
                    <div class="pm-modal-btns">
                        <button class="pm-btn-cancel" id="pm-edit-cancel">取消</button>
                        <button class="pm-btn-save" id="pm-edit-save">保存</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            setTimeout(() => document.getElementById('pm-edit-title')?.focus(), 50);
            this._bindCategorySelect(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
            document.getElementById('pm-edit-cancel').addEventListener('click', () => overlay.remove());
            document.getElementById('pm-edit-save').addEventListener('click', async () => { await this._savePrompt(overlay); });
            overlay.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') this._savePrompt(overlay); });
        },

        _bindCategorySelect(overlay) {
            const select = overlay.querySelector('#pm-edit-category');
            const wrap = overlay.querySelector('.pm-select[data-for="pm-edit-category"]');
            if (!select || !wrap) return;

            const trigger = wrap.querySelector('.pm-select-trigger');
            const valueText = wrap.querySelector('.pm-select-value');
            const options = [...wrap.querySelectorAll('.pm-select-option')];

            const close = () => {
                wrap.classList.remove('pm-open');
                trigger.setAttribute('aria-expanded', 'false');
            };
            const open = () => {
                wrap.classList.add('pm-open');
                trigger.setAttribute('aria-expanded', 'true');
            };
            const setValue = (value) => {
                select.value = value;
                valueText.textContent = value;
                options.forEach(btn => {
                    const selected = btn.dataset.value === value;
                    btn.classList.toggle('pm-selected', selected);
                    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
                });
                select.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const focusOption = (offset) => {
                const current = Math.max(0, options.findIndex(btn => btn.dataset.value === select.value));
                const next = options[(current + offset + options.length) % options.length];
                next?.focus();
            };

            trigger.addEventListener('click', e => {
                e.stopPropagation();
                wrap.classList.contains('pm-open') ? close() : open();
            });
            trigger.addEventListener('keydown', e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); open(); focusOption(0); }
                if (e.key === 'ArrowUp') { e.preventDefault(); open(); focusOption(-1); }
                if (e.key === 'Escape') close();
            });
            options.forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    setValue(btn.dataset.value);
                    close();
                    trigger.focus();
                });
                btn.addEventListener('keydown', e => {
                    const idx = options.indexOf(btn);
                    if (e.key === 'ArrowDown') { e.preventDefault(); options[(idx + 1) % options.length]?.focus(); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); options[(idx - 1 + options.length) % options.length]?.focus(); }
                    if (e.key === 'Home') { e.preventDefault(); options[0]?.focus(); }
                    if (e.key === 'End') { e.preventDefault(); options[options.length - 1]?.focus(); }
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setValue(btn.dataset.value);
                        close();
                        trigger.focus();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        close();
                        trigger.focus();
                    }
                });
            });
            overlay.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
        },

        async _savePrompt(overlay) {
            const title = document.getElementById('pm-edit-title').value.trim();
            const content = document.getElementById('pm-edit-content').value.trim();
            const category = document.getElementById('pm-edit-category').value;
            const tagsStr = document.getElementById('pm-edit-tags').value.trim();
            const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];

            if (!title) { toast('请输入标题'); return; }
            if (!content) { toast('请输入提示词内容'); return; }

            if (this._editingId) {
                const idx = this._prompts.findIndex(p => p.id === this._editingId);
                if (idx !== -1) this._prompts[idx] = PromptService.update(this._prompts[idx], { title, content, category, tags });
            } else {
                // Shift existing normal items up by 1, place new at the beginning
                this._prompts.filter(p => !p.favorite).forEach(p => { p.sortOrder = (p.sortOrder || 10000) + 1; });
                this._prompts.push(PromptService.create({ title, content, category, tags, sortOrder: 10000 }));
            }
            await StorageService.save(this._prompts);
            overlay.remove();
            this.renderList();
            this.renderCategories();
            toast(this._editingId ? '已更新' : '已添加');
        },
    };

    // ============================================================
    // Section 15: SPA Monitoring
    // ============================================================
    let lastUrl = '';
    function startMonitoring() {
        const checkUrl = () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                allRounds = []; seenPrompts.clear();
                _userUploadedFileIds = new Set();
                lastFetchConvId = '';
                const rpBody = document.getElementById('rp-body'); if (rpBody) rpBody.innerHTML = '';
                updateFab(); updateExtractedFooter();
                if (activeTab === 'library') LibraryUI.render();
            }
        };
        setInterval(checkUrl, 1000);

        let debounce = null;
        const obs = new MutationObserver(() => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                // Re-mount UI if removed
                if (!document.getElementById(Config.PANEL_ID)) { createFab(); createPanel(); applyPanelMode(); }
                // Enrich images for extracted prompts
                const total = allRounds.reduce((s, r) => s + r.prompts.length, 0);
                if (total > 0) {
                    const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
                    if (noImgCount > 0) {
                        const imgs = getAllDomImages(_userUploadedFileIds);
                        if (imgs.length > 0) { enrichWithDomImages(allRounds, null, _userUploadedFileIds); renderExtractedTab(); }
                    }
                }
            }, 3000);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ============================================================
    // Section 16: Bootstrap
    // ============================================================
    async function boot() {
        log('v' + Config.VERSION + ' 启动');
        injectStyles();
        await LibraryUI.init();
        panelMode = (await GM_getValue(Config.MODE_KEY)) || 'docked';
        createFab();
        createPanel();
        applyPanelMode();
        startMonitoring();

        if (getConversationId()) {
            log('当前对话:', getConversationId());
            updateFab();
        }
    }

    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);

    // Menu commands
    GM_registerMenuCommand('打开提示词套件', () => togglePanel(true));
    GM_registerMenuCommand('导出提示词备份', () => { StorageService.exportJSON(LibraryUI._prompts); toast('已导出'); });

    })();
