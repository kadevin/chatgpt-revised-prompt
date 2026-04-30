// ==UserScript==
// @name         ChatGPT 图片生成优化提示词提取器
// @namespace    https://github.com/chatgpt-revised-prompt
// @version      3.0.0
// @description  在 ChatGPT 网页版中提取并显示图片生成的优化提示词 (revised_prompt)
// @author       iLab
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    function log(...a) { if (DEBUG) console.log('%c[RP]', 'color:#10a37f;font-weight:bold', ...a); }

    // ===== 工具函数 =====
    function getConversationId() {
        const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
        return m ? m[1] : null;
    }

    function getAccessToken() {
        try {
            const el = document.getElementById('client-bootstrap');
            if (el) {
                const data = JSON.parse(el.textContent);
                return data?.accessToken || data?.session?.accessToken || null;
            }
        } catch (e) {}
        return null;
    }

    // ===== 全局状态 =====
    const shownPrompts = new Set();
    let allPrompts = []; // {prompt, source, index}

    // ===== 样式注入 =====
    function injectStyles() {
        if (document.getElementById('rp-styles')) return;
        const s = document.createElement('style');
        s.id = 'rp-styles';
        s.textContent = `
/* 悬浮触发按钮 */
#rp-fab{position:fixed;bottom:80px;right:20px;z-index:99998;width:44px;height:44px;border-radius:50%;
    border:none;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#10a37f,#1a7f64);color:#fff;
    box-shadow:0 4px 16px rgba(16,163,127,.35);transition:all .25s;user-select:none}
#rp-fab:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(16,163,127,.45)}
#rp-fab .rp-badge-count{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;
    border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;
    display:flex;align-items:center;justify-content:center;padding:0 4px;
    box-shadow:0 1px 4px rgba(0,0,0,.2)}
/* 侧边面板 */
#rp-panel{position:fixed;bottom:136px;right:20px;z-index:99997;width:380px;max-height:65vh;
    background:#fff;border-radius:14px;overflow:hidden;display:none;flex-direction:column;
    box-shadow:0 8px 40px rgba(0,0,0,.15),0 0 0 1px rgba(0,0,0,.05);
    animation:rp-slide-up .25s ease}
#rp-panel.open{display:flex}
html.dark #rp-panel{background:#1e1e2e;box-shadow:0 8px 40px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06)}
@keyframes rp-slide-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
/* 面板头部 */
.rp-panel-hdr{display:flex;align-items:center;gap:8px;padding:12px 16px;
    border-bottom:1px solid rgba(0,0,0,.06);font-weight:600;font-size:14px;color:#202123;flex-shrink:0}
html.dark .rp-panel-hdr{border-bottom-color:rgba(255,255,255,.06);color:#e5e5e5}
.rp-panel-hdr .rp-count{margin-left:auto;font-size:11px;font-weight:500;color:#6e6e80;
    background:rgba(0,0,0,.05);padding:2px 8px;border-radius:10px}
html.dark .rp-panel-hdr .rp-count{background:rgba(255,255,255,.08);color:#9ca3af}
/* 面板内容列表 */
.rp-panel-body{overflow-y:auto;flex:1;padding:8px}
/* 单个提示词卡片 */
.rp-card{border-radius:10px;margin-bottom:6px;overflow:hidden;
    border:1px solid rgba(0,0,0,.06);transition:border-color .2s}
.rp-card:hover{border-color:rgba(16,163,127,.2)}
html.dark .rp-card{border-color:rgba(255,255,255,.06)}
html.dark .rp-card:hover{border-color:rgba(16,163,127,.3)}
/* 卡片头部 - 可点击展开 */
.rp-card-hdr{display:flex;align-items:center;gap:6px;padding:8px 12px;cursor:pointer;
    user-select:none;font-size:12px;font-weight:500;color:#6e6e80;transition:background .15s}
.rp-card-hdr:hover{background:rgba(0,0,0,.02)}
html.dark .rp-card-hdr:hover{background:rgba(255,255,255,.03)}
html.dark .rp-card-hdr{color:#9ca3af}
.rp-card-arrow{transition:transform .2s;color:#10a37f;width:14px;display:flex;align-items:center;justify-content:center}
.rp-card.open .rp-card-arrow{transform:rotate(90deg)}
.rp-card-tag{padding:2px 6px;border-radius:4px;font-size:10px;font-weight:500;display:flex;align-items:center;gap:4px;
    background:rgba(16,163,127,.1);color:#10a37f;line-height:1}
.rp-card-tag svg{width:11px;height:11px;opacity:0.8}
.rp-card-preview{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#999}
html.dark .rp-card-preview{color:#666}
/* 卡片内容 - 展开时显示 */
.rp-card-body{display:none;padding:0 12px 10px}
.rp-card.open .rp-card-body{display:block}
.rp-card-txt{background:rgba(0,0,0,.03);border-radius:8px;padding:10px 12px;
    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;line-height:1.6;
    white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;color:#374151}
html.dark .rp-card-txt{background:rgba(255,255,255,.04);color:#d1d5db}
.rp-card-acts{display:flex;margin-top:10px}
.rp-copy-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border:none;border-radius:8px;
    font-size:13px;font-weight:500;cursor:pointer;background:rgba(16,163,127,.1);color:#10a37f;font-family:inherit;transition:all .15s;width:100%}
.rp-copy-btn:hover{background:rgba(16,163,127,.2)} .rp-copy-btn.ok{background:#10a37f;color:#fff}
/* Toast */
.rp-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);
    background:#10a37f;color:#fff;padding:8px 20px;border-radius:8px;font-size:13px;
    z-index:99999;opacity:0;transition:all .3s;pointer-events:none}
.rp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
/* 状态指示 */
.rp-status{position:fixed;bottom:10px;right:10px;z-index:99999;background:rgba(0,0,0,.8);
    color:#0f0;font-size:11px;padding:4px 10px;border-radius:6px;font-family:monospace}
        `;
        document.head.appendChild(s);
    }

    // ===== UI 组件 =====
    function toast(m) {
        let t = document.querySelector('.rp-toast');
        if (!t) { t = document.createElement('div'); t.className = 'rp-toast'; document.body.appendChild(t); }
        t.textContent = m; t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 1800);
    }

    function showStatus(msg) {
        let el = document.querySelector('.rp-status');
        if (!el) { el = document.createElement('div'); el.className = 'rp-status'; document.body.appendChild(el); }
        el.textContent = '[RP] ' + msg;
        clearTimeout(el._timer);
        el._timer = setTimeout(() => el.remove(), 10000);
    }

    // 创建悬浮按钮
    function createFab() {
        if (document.getElementById('rp-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'rp-fab';
        fab.title = '查看图片优化提示词';
        fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"></path><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"></path></svg>`;
        fab.style.display = 'none'; // 初始隐藏，有提示词时显示
        fab.onclick = () => togglePanel();
        document.body.appendChild(fab);
    }

    // 创建侧边面板
    function createPanel() {
        if (document.getElementById('rp-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'rp-panel';
        panel.innerHTML = `
            <div class="rp-panel-hdr">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"></path><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"></path></svg>
                <span>优化提示词</span>
                <span class="rp-count" id="rp-count">0</span>
            </div>
            <div class="rp-panel-body" id="rp-panel-body"></div>
        `;
        document.body.appendChild(panel);
    }

    function togglePanel() {
        const panel = document.getElementById('rp-panel');
        if (panel) panel.classList.toggle('open');
    }

    // 更新 FAB 上的计数
    function updateFabCount() {
        const fab = document.getElementById('rp-fab');
        if (!fab) return;
        const count = allPrompts.length;
        if (count > 0) {
            fab.style.display = 'flex';
            // 移除旧 badge
            const old = fab.querySelector('.rp-badge-count');
            if (old) old.remove();
            const badge = document.createElement('span');
            badge.className = 'rp-badge-count';
            badge.textContent = count;
            fab.appendChild(badge);
        } else {
            fab.style.display = 'none';
        }
        // 更新面板头部计数
        const countEl = document.getElementById('rp-count');
        if (countEl) countEl.textContent = count + ' 条';
    }

    // 添加一条提示词到面板
    function addPromptToPanel(prompt, source, index) {
        const body = document.getElementById('rp-panel-body');
        if (!body) return;

        const card = document.createElement('div');
        card.className = 'rp-card';
        card.dataset.rpIdx = index;

        const svgCode = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
        const svgImage = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
        const svgPen = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;

        const sourceLabel = {
            'code': svgCode + 'Code',
            'caption': svgPen + 'Caption',
            'generation': svgImage + 'Gen',
            'gen.prompt': svgImage + 'Gen',
            'dalle': svgImage + 'DALL-E',
            'meta.dalle': svgImage + 'DALL-E',
            'ig_meta': svgImage + 'IG',
            'agg': svgImage + 'Agg',
        }[source] || svgPen + source;

        const preview = prompt.substring(0, 60).replace(/\n/g, ' ') + (prompt.length > 60 ? '...' : '');

        // 头部
        const hdr = document.createElement('div');
        hdr.className = 'rp-card-hdr';
        hdr.innerHTML = `
            <span class="rp-card-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
            <span class="rp-card-tag">${sourceLabel}</span>
            <span class="rp-card-preview">${escHtml(preview)}</span>
        `;
        hdr.onclick = () => card.classList.toggle('open');

        // 内容
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'rp-card-body';

        const txt = document.createElement('div');
        txt.className = 'rp-card-txt';
        txt.textContent = prompt;

        const acts = document.createElement('div');
        acts.className = 'rp-card-acts';

        const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        const checkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'rp-copy-btn';
        copyBtn.innerHTML = copyIcon + ' 复制提示词';
        copyBtn.onclick = e => {
            e.stopPropagation();
            navigator.clipboard.writeText(prompt).catch(() => {});
            copyBtn.classList.add('ok'); copyBtn.innerHTML = checkIcon + ' 已复制'; toast('已复制到剪贴板');
            setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.innerHTML = copyIcon + ' 复制提示词'; }, 1500);
        };
        acts.appendChild(copyBtn);

        bodyDiv.appendChild(txt);
        bodyDiv.appendChild(acts);
        card.appendChild(hdr);
        card.appendChild(bodyDiv);
        body.appendChild(card);
    }

    function escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 清空面板内容
    function clearPanel() {
        const body = document.getElementById('rp-panel-body');
        if (body) body.innerHTML = '';
        allPrompts = [];
        shownPrompts.clear();
        updateFabCount();
    }

    // ===== 核心 API 调用 =====
    async function fetchAndExtractPrompts() {
        const convId = getConversationId();
        if (!convId) {
            log('未检测到对话ID');
            return;
        }

        const token = getAccessToken();
        if (!token) {
            log('⚠️ 未获取到 accessToken');
            showStatus('无法获取 token');
            return;
        }

        log('📡 请求对话数据:', convId);
        showStatus('正在获取对话数据...');

        try {
            const resp = await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
            });

            log('📡 API 状态:', resp.status, resp.statusText);

            if (!resp.ok) {
                log('❌ API 错误:', resp.status);
                showStatus('API错误: ' + resp.status);
                return;
            }

            const data = await resp.json();

            const prompts = extractRevisedPrompts(data);
            log(`🔍 提取结果: ${prompts.length} 个 revised_prompt`);

            if (prompts.length > 0) {
                let newCount = 0;
                for (const { prompt, source } of prompts) {
                    if (shownPrompts.has(prompt)) continue;
                    shownPrompts.add(prompt);
                    allPrompts.push({ prompt, source, index: allPrompts.length });
                    addPromptToPanel(prompt, source, allPrompts.length - 1);
                    log(`🎉 [${source}]`, prompt.substring(0, 80));
                    newCount++;
                }
                updateFabCount();
                if (newCount > 0) {
                    showStatus(`找到 ${allPrompts.length} 个提示词`);
                }
            } else {
                showStatus('未找到 revised_prompt');
            }
        } catch (e) {
            log('❌ API 请求失败:', e.message);
            showStatus('请求失败: ' + e.message);
        }
    }

    // ===== 提取 revised_prompt =====
    function extractRevisedPrompts(conversationData) {
        const results = [];
        const mapping = conversationData?.mapping;
        if (!mapping) return results;

        for (const [nodeId, node] of Object.entries(mapping)) {
            const msg = node?.message;
            if (!msg) continue;

            const messageId = msg.id;
            const role = msg.author?.role;
            const contentType = msg.content?.content_type;
            const parts = msg.content?.parts;

            // ========== 策略 A: assistant code 消息 (image_gen.text2im 调用) ==========
            if (role === 'assistant' && contentType === 'code' && Array.isArray(parts)) {
                for (const part of parts) {
                    if (typeof part !== 'string') continue;
                    const codePrompts = extractPromptsFromCode(part);
                    for (const cp of codePrompts) {
                        results.push({ prompt: cp, messageId, source: 'code' });
                    }
                }
            }

            // ========== 策略 B: tool multimodal_text ("Model caption" 字符串) ==========
            if (role === 'tool' && contentType === 'multimodal_text' && Array.isArray(parts)) {
                for (const part of parts) {
                    if (typeof part === 'string' && part.length > 50) {
                        if (part.startsWith('Model caption:')) {
                            const caption = part.substring('Model caption:'.length).trim();
                            if (caption.length > 20) {
                                results.push({ prompt: caption, messageId, source: 'caption' });
                            }
                        }
                    }
                    if (part && typeof part === 'object' && part.metadata) {
                        const gen = part.metadata.generation;
                        if (gen) {
                            if (typeof gen === 'string' && gen.length > 20) {
                                results.push({ prompt: gen, messageId, source: 'generation' });
                            } else if (gen.prompt && gen.prompt.length > 20) {
                                results.push({ prompt: gen.prompt, messageId, source: 'gen.prompt' });
                            }
                        }
                        const partDalle = part.metadata.dalle;
                        if (partDalle) {
                            const rp = partDalle.revised_prompt || (partDalle.prompt && partDalle.prompt.length > 10 ? partDalle.prompt : null);
                            if (rp && rp.length > 10) {
                                results.push({ prompt: rp, messageId, source: 'dalle' });
                            }
                        }
                    }
                }
            }

            // ========== 策略 D: 传统 dalle metadata ==========
            const dalle = msg.metadata?.dalle;
            if (dalle) {
                const rp = dalle.revised_prompt || (dalle.prompt && dalle.prompt.length > 10 ? dalle.prompt : null);
                if (rp && rp.length > 10) {
                    results.push({ prompt: rp, messageId, source: 'meta.dalle' });
                }
            }

            // 策略 E: image_generation metadata
            const igMeta = msg.metadata?.image_generation || msg.metadata?.image_gen_metadata;
            if (igMeta?.revised_prompt) {
                results.push({ prompt: igMeta.revised_prompt, messageId, source: 'ig_meta' });
            }

            // 策略 F: aggregate_result
            const aggPrompts = msg.metadata?.aggregate_result?.dalle?.prompts;
            if (Array.isArray(aggPrompts)) {
                for (const dp of aggPrompts) {
                    if (dp?.revised_prompt) {
                        results.push({ prompt: dp.revised_prompt, messageId, source: 'agg' });
                    }
                }
            }
        }

        // 清理控制标记并去重
        const seen = new Set();
        return results
            .map(r => ({
                ...r,
                prompt: r.prompt
                    .replace(/<\|[a-z_]+\|>/gi, '')  // 去除 <|has_watermark|> 等标记
                    .replace(/\s+$/, '')               // 去除末尾空白
            }))
            .filter(r => {
                if (r.prompt.length < 10) return false;
                if (seen.has(r.prompt)) return false;
                seen.add(r.prompt);
                return true;
            });
    }

    // 从 code 文本中提取 prompt
    function extractPromptsFromCode(codeText) {
        const prompts = [];
        const tripleQuoteRegex = /prompt\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/g;
        let m;
        while ((m = tripleQuoteRegex.exec(codeText)) !== null) {
            const p = (m[1] || m[2] || '').trim();
            if (p.length > 20) prompts.push(p);
        }
        if (prompts.length === 0) {
            const singleQuoteRegex = /prompt\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            while ((m = singleQuoteRegex.exec(codeText)) !== null) {
                const p = (m[1] || m[2] || '').trim();
                if (p.length > 20) prompts.push(p);
            }
        }
        if (prompts.length === 0) {
            const funcRegex = /text2im\s*\(\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            while ((m = funcRegex.exec(codeText)) !== null) {
                const p = (m[1] || m[2] || m[3] || m[4] || '').trim();
                if (p.length > 20) prompts.push(p);
            }
        }
        return prompts;
    }

    // ===== 主循环 =====
    let lastUrl = '';

    function startMonitoring() {
        const checkUrl = () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                clearPanel();
                const panel = document.getElementById('rp-panel');
                if (panel) panel.classList.remove('open');
                log('页面切换:', location.pathname);
                if (getConversationId()) {
                    setTimeout(() => fetchAndExtractPrompts(), 1500);
                }
            }
        };
        setInterval(checkUrl, 1000);

        // MutationObserver 监测新图片出现
        let debounce = null;
        const observer = new MutationObserver(() => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                // 如果有图片且当前面板为空，尝试重新获取
                const imgs = document.querySelectorAll('img[src*="oaiusercontent"], img[src*="dalle"], [data-message-id] img[src^="http"]');
                if (imgs.length > 0 && allPrompts.length === 0 && getConversationId()) {
                    fetchAndExtractPrompts();
                }
            }, 3000);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // 初始加载
        if (getConversationId()) {
            log('当前对话:', getConversationId());
            showStatus('正在获取对话数据...');
            fetchAndExtractPrompts();
        }
    }

    // ===== 启动 =====
    function boot() {
        log('🎨 v3.0 启动 (悬浮面板模式)');
        injectStyles();
        createFab();
        createPanel();
        startMonitoring();
    }

    if (document.readyState === 'complete') {
        boot();
    } else {
        window.addEventListener('load', boot);
    }
})();
