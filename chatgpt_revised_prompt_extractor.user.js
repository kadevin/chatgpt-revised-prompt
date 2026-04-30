// ==UserScript==
// @name         ChatGPT 图片生成优化提示词提取器
// @namespace    https://github.com/kadevin/chatgpt-revised-prompt
// @version      4.0.0
// @description  提取 ChatGPT 图片生成优化提示词，支持缩略图预览、多选批量下载
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

function getConversationId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
    return m ? m[1] : null;
}
function getAccessToken() {
    try {
        const el = document.getElementById('client-bootstrap');
        if (el) { const d = JSON.parse(el.textContent); return d?.accessToken || d?.session?.accessToken || null; }
    } catch(e) {}
    return null;
}

// 全局状态：按轮次分组
let allRounds = []; // [{roundIndex, userText, prompts:[{prompt,source,imageUrls,selected,id}]}]
const seenPrompts = new Set();

function injectStyles() {
    if (document.getElementById('rp-styles')) return;
    const s = document.createElement('style');
    s.id = 'rp-styles';
    s.textContent = `
#rp-fab{position:fixed;bottom:80px;right:20px;z-index:99998;width:44px;height:44px;border-radius:50%;
    border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#10a37f,#1a7f64);color:#fff;
    box-shadow:0 4px 16px rgba(16,163,127,.35);transition:all .25s;user-select:none}
#rp-fab:hover{transform:scale(1.08)}
#rp-fab .rp-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;
    border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;
    display:flex;align-items:center;justify-content:center;padding:0 4px}
#rp-panel{position:fixed;bottom:136px;right:20px;z-index:99997;width:400px;max-height:68vh;
    background:#fff;border-radius:14px;overflow:hidden;display:none;flex-direction:column;
    box-shadow:0 8px 40px rgba(0,0,0,.15),0 0 0 1px rgba(0,0,0,.05);
    animation:rp-up .25s ease;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#rp-panel.open{display:flex}
html.dark #rp-panel{background:#1e1e2e;box-shadow:0 8px 40px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.06)}
@keyframes rp-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.rp-hdr{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-shrink:0;
    border-bottom:1px solid rgba(0,0,0,.06);font-weight:600;font-size:13px;color:#202123}
html.dark .rp-hdr{border-bottom-color:rgba(255,255,255,.06);color:#e5e5e5}
.rp-hdr-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.rp-sel-all{font-size:11px;padding:3px 8px;border:1px solid rgba(16,163,127,.3);border-radius:5px;
    background:none;color:#10a37f;cursor:pointer;font-family:inherit}
.rp-sel-all:hover{background:rgba(16,163,127,.07)}
.rp-count-badge{font-size:11px;font-weight:500;color:#6e6e80;background:rgba(0,0,0,.05);
    padding:2px 8px;border-radius:10px}
html.dark .rp-count-badge{background:rgba(255,255,255,.08);color:#9ca3af}
.rp-body{overflow-y:auto;flex:1;padding:6px}
.rp-round-divider{display:flex;align-items:center;gap:8px;margin:10px 4px 6px;font-size:11px;
    font-weight:600;color:#9ca3af}
.rp-round-divider::before,.rp-round-divider::after{content:'';flex:1;height:1px;background:rgba(0,0,0,.08)}
html.dark .rp-round-divider::before,html.dark .rp-round-divider::after{background:rgba(255,255,255,.08)}
.rp-card{border-radius:10px;margin-bottom:5px;overflow:hidden;
    border:1px solid rgba(0,0,0,.07);transition:border-color .18s,background .18s}
.rp-card:hover{border-color:rgba(16,163,127,.25)}
html.dark .rp-card{border-color:rgba(255,255,255,.07)}
html.dark .rp-card:hover{border-color:rgba(16,163,127,.3)}
.rp-card.selected{border-color:#10a37f;background:rgba(16,163,127,.04)}
html.dark .rp-card.selected{background:rgba(16,163,127,.08)}
.rp-card-hdr{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:pointer;
    user-select:none;font-size:11px;font-weight:500;color:#6e6e80;transition:background .13s}
.rp-card-hdr:hover{background:rgba(0,0,0,.02)}
html.dark .rp-card-hdr{color:#9ca3af}
html.dark .rp-card-hdr:hover{background:rgba(255,255,255,.03)}
.rp-cb{width:15px;height:15px;accent-color:#10a37f;cursor:pointer;flex-shrink:0;margin:0}
.rp-thumb-strip{display:flex;gap:3px;flex-shrink:0}
.rp-thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;
    border:1px solid rgba(0,0,0,.08);background:#f3f4f6}
html.dark .rp-thumb{border-color:rgba(255,255,255,.1);background:#374151}
.rp-thumb-ph{width:48px;height:48px;border-radius:6px;border:1px dashed rgba(0,0,0,.12);
    background:rgba(0,0,0,.03);display:flex;align-items:center;justify-content:center;flex-shrink:0}
html.dark .rp-thumb-ph{border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
.rp-card-meta{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.rp-tag{padding:2px 5px;border-radius:4px;font-size:9px;font-weight:600;align-self:flex-start;
    background:rgba(16,163,127,.1);color:#10a37f;line-height:1.4}
.rp-preview{font-size:11px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
html.dark .rp-preview{color:#555}
.rp-arrow{flex-shrink:0;transition:transform .18s;color:#10a37f;opacity:.7}
.rp-card.open .rp-arrow{transform:rotate(90deg)}
.rp-card-body{display:none;padding:0 10px 10px}
.rp-card.open .rp-card-body{display:block}
.rp-img-gallery{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.rp-img-gallery img{width:80px;height:80px;object-fit:cover;border-radius:7px;
    cursor:pointer;border:1px solid rgba(0,0,0,.08);transition:transform .15s}
.rp-img-gallery img:hover{transform:scale(1.03)}
html.dark .rp-img-gallery img{border-color:rgba(255,255,255,.1)}
.rp-txt{background:rgba(0,0,0,.03);border-radius:7px;padding:9px 11px;
    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;line-height:1.6;
    white-space:pre-wrap;word-break:break-word;max-height:160px;overflow-y:auto;color:#374151}
html.dark .rp-txt{background:rgba(255,255,255,.04);color:#d1d5db}
.rp-card-acts{display:flex;gap:6px;margin-top:8px}
.rp-copy-btn,.rp-dl-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;
    padding:7px 12px;border:none;border-radius:7px;font-size:12px;font-weight:500;
    cursor:pointer;font-family:inherit;transition:all .15s;flex:1}
.rp-copy-btn{background:rgba(16,163,127,.1);color:#10a37f}
.rp-copy-btn:hover{background:rgba(16,163,127,.2)}
.rp-copy-btn.ok{background:#10a37f;color:#fff}
.rp-dl-btn{background:rgba(59,130,246,.08);color:#3b82f6}
.rp-dl-btn:hover{background:rgba(59,130,246,.15)}
.rp-footer{padding:8px 10px;border-top:1px solid rgba(0,0,0,.06);display:flex;gap:6px;flex-shrink:0}
html.dark .rp-footer{border-top-color:rgba(255,255,255,.06)}
.rp-dl-sel-btn,.rp-dl-all-btn{display:inline-flex;align-items:center;justify-content:center;
    gap:5px;padding:7px 10px;border:none;border-radius:8px;font-size:12px;font-weight:500;
    cursor:pointer;font-family:inherit;transition:all .15s}
.rp-dl-sel-btn{background:#3b82f6;color:#fff;flex:1}
.rp-dl-sel-btn:hover{background:#2563eb}
.rp-dl-sel-btn:disabled{background:#9ca3af;cursor:not-allowed}
.rp-dl-all-btn{background:rgba(0,0,0,.05);color:#374151;flex:1}
.rp-dl-all-btn:hover{background:rgba(0,0,0,.09)}
html.dark .rp-dl-all-btn{background:rgba(255,255,255,.08);color:#d1d5db}
html.dark .rp-dl-all-btn:hover{background:rgba(255,255,255,.12)}
.rp-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(16px);
    background:#10a37f;color:#fff;padding:7px 18px;border-radius:8px;font-size:13px;
    z-index:99999;opacity:0;transition:all .28s;pointer-events:none}
.rp-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.rp-status{position:fixed;bottom:10px;right:10px;z-index:99999;background:rgba(0,0,0,.8);
    color:#0f0;font-size:11px;padding:3px 9px;border-radius:5px;font-family:monospace}
    `;
    document.head.appendChild(s);
}

const SVG = {
    brush: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>`,
    arrow: `<svg class="rp-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    img: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".3"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
};

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
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), 8000);
}
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function createFab() {
    if (document.getElementById('rp-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'rp-fab'; fab.title = '查看图片优化提示词';
    fab.innerHTML = SVG.brush;
    fab.style.display = 'none';
    fab.onclick = () => { const p = document.getElementById('rp-panel'); if(p) p.classList.toggle('open'); };
    document.body.appendChild(fab);
}

function createPanel() {
    if (document.getElementById('rp-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'rp-panel';
    panel.innerHTML = `
        <div class="rp-hdr">
            ${SVG.brush.replace('width="20" height="20"','width="16" height="16"')}
            <span>优化提示词</span>
            <div class="rp-hdr-right">
                <button class="rp-sel-all" id="rp-sel-all">全选</button>
                <span class="rp-count-badge" id="rp-count">0</span>
            </div>
        </div>
        <div class="rp-body" id="rp-body"></div>
        <div class="rp-footer">
            <button class="rp-dl-sel-btn" id="rp-dl-sel" disabled>${SVG.download} 下载选中 (0)</button>
            <button class="rp-dl-all-btn" id="rp-dl-all">${SVG.download} 全部下载</button>
        </div>`;
    document.body.appendChild(panel);

    document.getElementById('rp-sel-all').onclick = toggleSelectAll;
    document.getElementById('rp-dl-sel').onclick = downloadSelected;
    document.getElementById('rp-dl-all').onclick = downloadAll;
}

function updateFab() {
    const fab = document.getElementById('rp-fab');
    if (!fab) return;
    const total = allRounds.reduce((s,r) => s + r.prompts.length, 0);
    fab.style.display = total > 0 ? 'flex' : 'none';
    const old = fab.querySelector('.rp-badge'); if (old) old.remove();
    if (total > 0) {
        const b = document.createElement('span'); b.className = 'rp-badge'; b.textContent = total;
        fab.appendChild(b);
    }
    const ce = document.getElementById('rp-count'); if (ce) ce.textContent = total + ' 条';
}

function updateFooter() {
    const allP = allRounds.flatMap(r => r.prompts);
    const selCount = allP.filter(p => p.selected).length;
    const btn = document.getElementById('rp-dl-sel');
    if (btn) {
        btn.disabled = selCount === 0;
        btn.innerHTML = `${SVG.download} 下载选中 (${selCount})`;
    }
    const allBtn = document.getElementById('rp-dl-all');
    if (allBtn) allBtn.innerHTML = `${SVG.download} 全部下载 (${allP.length})`;
}

function toggleSelectAll() {
    const allP = allRounds.flatMap(r => r.prompts);
    const allSelected = allP.every(p => p.selected);
    allP.forEach(p => p.selected = !allSelected);
    document.querySelectorAll('.rp-cb').forEach(cb => cb.checked = !allSelected);
    document.querySelectorAll('.rp-card').forEach(card => card.classList.toggle('selected', !allSelected));
    document.getElementById('rp-sel-all').textContent = allSelected ? '全选' : '取消全选';
    updateFooter();
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

async function downloadSelected() {
    const selP = allRounds.flatMap(r => r.prompts).filter(p => p.selected);
    const urls = selP.flatMap(p => p.imageUrls);
    if (!urls.length) return;
    toast(`开始下载 ${urls.length} 张图片...`);
    for (let i = 0; i < urls.length; i++) {
        await downloadImage(urls[i], `chatgpt-img-${Date.now()}-${i+1}.png`);
        await new Promise(r => setTimeout(r, 300));
    }
}

async function downloadAll() {
    const urls = allRounds.flatMap(r => r.prompts).flatMap(p => p.imageUrls);
    if (!urls.length) { toast('没有可下载的图片'); return; }
    toast(`开始下载全部 ${urls.length} 张图片...`);
    for (let i = 0; i < urls.length; i++) {
        await downloadImage(urls[i], `chatgpt-img-${Date.now()}-${i+1}.png`);
        await new Promise(r => setTimeout(r, 300));
    }
}

// 懒解析：在渲染前尝试从 DOM 匹配 fileIds 到图片 URL
function resolveFileIds() {
    const allP = allRounds.flatMap(r => r.prompts);
    for (const item of allP) {
        if (item.imageUrls.length > 0 || !item.fileIds || item.fileIds.length === 0) continue;
        for (const fid of item.fileIds) {
            const img = document.querySelector(`img[src*="${fid}"]`);
            if (img && img.src && !item.imageUrls.includes(img.src)) {
                item.imageUrls.push(img.src);
            }
        }
    }
    // 兜底：收集所有 DOM 图片按顺序分配
    if (allP.some(p => p.imageUrls.length === 0 && p.fileIds?.length > 0)) {
        const domImgs = getAllDomImages();
        const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
        const unused = domImgs.filter(u => !usedUrls.has(u));
        let idx = 0;
        for (const item of allP) {
            if (item.imageUrls.length === 0 && idx < unused.length) {
                item.imageUrls = [unused[idx++]];
            }
        }
    }
}

function renderPanel() {
    resolveFileIds(); // 每次渲染前尝试解析图片
    const body = document.getElementById('rp-body');
    if (!body) return;
    body.innerHTML = '';

    for (const round of allRounds) {
        if (!round.prompts.length) continue;
        const div = document.createElement('div');
        div.className = 'rp-round-divider';
        div.textContent = `第 ${round.roundIndex} 轮`;
        body.appendChild(div);

        for (const item of round.prompts) {
            body.appendChild(buildCard(item));
        }
    }
    updateFab(); updateFooter();
}

function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'rp-card';
    card.dataset.id = item.id;

    const sourceMap = { code:'Code', caption:'Caption', generation:'Gen', 'gen.prompt':'Gen',
        dalle:'DALL-E', 'meta.dalle':'DALL-E', ig_meta:'IG', agg:'Agg' };
    const tagLabel = sourceMap[item.source] || item.source;
    const preview = item.prompt.substring(0,55).replace(/\n/g,' ') + (item.prompt.length>55?'...':'');

    // Build thumbnail strip (show up to 2 thumbs in header)
    let thumbsHtml = '';
    if (item.imageUrls.length > 0) {
        thumbsHtml = '<div class="rp-thumb-strip">';
        item.imageUrls.slice(0, 2).forEach(url => {
            thumbsHtml += `<img class="rp-thumb" src="${escHtml(url)}" loading="lazy" onerror="this.style.display='none'">`;
        });
        thumbsHtml += '</div>';
    } else {
        thumbsHtml = `<div class="rp-thumb-ph">${SVG.img}</div>`;
    }

    // Gallery for expanded view
    let galleryHtml = '';
    if (item.imageUrls.length > 0) {
        galleryHtml = '<div class="rp-img-gallery">';
        item.imageUrls.forEach(url => {
            galleryHtml += `<img src="${escHtml(url)}" loading="lazy" title="点击新标签打开" onclick="window.open('${escHtml(url)}','_blank')" onerror="this.style.display='none'">`;
        });
        galleryHtml += '</div>';
    }

    card.innerHTML = `
        <div class="rp-card-hdr">
            <input type="checkbox" class="rp-cb" ${item.selected?'checked':''}>
            ${thumbsHtml}
            <div class="rp-card-meta">
                <span class="rp-tag">${escHtml(tagLabel)}</span>
                <span class="rp-preview">${escHtml(preview)}</span>
            </div>
            ${SVG.arrow}
        </div>
        <div class="rp-card-body">
            ${galleryHtml}
            <div class="rp-txt">${escHtml(item.prompt)}</div>
            <div class="rp-card-acts">
                <button class="rp-copy-btn">${SVG.copy} 复制提示词</button>
                ${item.imageUrls.length > 0 ? `<button class="rp-dl-btn">${SVG.download} 下载图片</button>` : ''}
            </div>
        </div>`;

    const hdr = card.querySelector('.rp-card-hdr');
    const cb = card.querySelector('.rp-cb');

    cb.onclick = e => {
        e.stopPropagation();
        item.selected = cb.checked;
        card.classList.toggle('selected', cb.checked);
        updateFooter();
    };

    hdr.onclick = e => {
        if (e.target === cb) return;
        card.classList.toggle('open');
    };

    const copyBtn = card.querySelector('.rp-copy-btn');
    copyBtn.onclick = e => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.prompt).catch(()=>{});
        copyBtn.classList.add('ok'); copyBtn.innerHTML = SVG.check + ' 已复制'; toast('已复制到剪贴板');
        setTimeout(() => { copyBtn.classList.remove('ok'); copyBtn.innerHTML = SVG.copy + ' 复制提示词'; }, 1500);
    };

    const dlBtn = card.querySelector('.rp-dl-btn');
    if (dlBtn) dlBtn.onclick = async e => {
        e.stopPropagation();
        toast(`下载 ${item.imageUrls.length} 张图片...`);
        for (let i = 0; i < item.imageUrls.length; i++) {
            await downloadImage(item.imageUrls[i], `chatgpt-img-${i+1}.png`);
            await new Promise(r => setTimeout(r, 300));
        }
    };

    return card;
}

// ===== 对话路径排序 =====
function getOrderedPath(mapping) {
    const childrenOf = {};
    for (const [id, node] of Object.entries(mapping)) {
        const pid = node.parent;
        if (pid) { if (!childrenOf[pid]) childrenOf[pid] = []; childrenOf[pid].push(id); }
    }
    const root = Object.keys(mapping).find(id => !mapping[id].parent);
    if (!root) return Object.keys(mapping);
    const path = [];
    const visited = new Set();
    let cur = root;
    while (cur && !visited.has(cur)) {
        visited.add(cur); path.push(cur);
        const ch = childrenOf[cur] || [];
        cur = ch[ch.length - 1];
    }
    return path;
}

// ===== 提取图片 URL =====
// ChatGPT 图片在 API 中使用 asset_pointer 格式: "file-service://file-xxxx"
// 需要从 DOM 中匹配对应的 <img> 元素获取真实 URL
function extractImageUrlsFromParts(parts) {
    const urls = [];
    const fileIds = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        // asset_pointer: "file-service://file-xxxx" (最常见的格式)
        if (part.asset_pointer && typeof part.asset_pointer === 'string') {
            const fid = part.asset_pointer.replace('file-service://', '');
            if (fid) fileIds.push(fid);
        }
        // Direct URL fallbacks
        if (typeof part.url === 'string' && part.url.startsWith('http')) urls.push(part.url);
        if (part.image_url?.url) urls.push(part.image_url.url);
        // metadata sources
        const gen = part.metadata?.generation;
        if (gen?.image_url) urls.push(gen.image_url);
        if (gen?.url) urls.push(gen.url);
        const dalle = part.metadata?.dalle;
        if (dalle?.image_url) urls.push(dalle.image_url);
        if (dalle?.url) urls.push(dalle.url);
    }
    // 从 DOM 中通过 file ID 查找实际图片 URL
    for (const fid of fileIds) {
        const img = document.querySelector(`img[src*="${fid}"]`);
        if (img && img.src) {
            urls.push(img.src);
            log('🖼️ 通过 asset_pointer 匹配到图片:', fid);
        } else {
            log('⚠️ DOM 中未找到 asset_pointer 图片:', fid);
        }
    }
    return [...new Set(urls)];
}

// 收集 parts 中所有 file ID (用于延迟匹配)
function extractFileIdsFromParts(parts) {
    const ids = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.asset_pointer && typeof part.asset_pointer === 'string') {
            ids.push(part.asset_pointer.replace('file-service://', ''));
        }
    }
    return ids;
}

function getAllDomImages() {
    // 在主聊天区内查找所有可能的生成图片
    const mainArea = document.querySelector('#thread') || document.querySelector('main') || document.body;
    const allImgs = [...mainArea.querySelectorAll('img[src^="https"]')];
    const results = allImgs
        .filter(img => {
            const s = img.src;
            if (s.includes('cdn.openai.com') || s.includes('favicon') || s.includes('sprites') || s.includes('avatar') || s.includes('og.png')) return false;
            if (s.includes('oaiusercontent') || s.includes('openai.com/file') || s.includes('dalleprodsec')) return true;
            if (img.naturalWidth >= 100 || img.width >= 100) return true;
            if (img.alt && img.alt.length > 5) return true;
            return false;
        })
        .map(img => img.src);
    log('🖼️ getAllDomImages:', results.length, '张');
    return [...new Set(results)];
}

function getImagesFromDomByMsgId(msgId) {
    if (!msgId) return [];
    let el = document.querySelector(`[data-message-id="${msgId}"]`);
    if (el) {
        const imgs = [...el.querySelectorAll('img[src^="https"]')]
            .map(i => i.src)
            .filter(s => !s.includes('cdn.openai.com') && !s.includes('favicon') && !s.includes('sprites'));
        if (imgs.length) return imgs;
    }
    return [];
}

// ===== 核心提取 =====
function buildRounds(conversationData) {
    const mapping = conversationData?.mapping;
    if (!mapping) return [];

    const path = getOrderedPath(mapping);
    const rounds = [];
    let currentRound = null;
    let lastAssistantMsgId = null;

    // Helper: add prompt to current round
    function addPrompt(prompt, source, imageUrls, toolMsgId, fileIds) {
        if (!currentRound) {
            currentRound = { roundIndex: rounds.length + 1, userText: '...', prompts: [] };
            rounds.push(currentRound);
        }
        const cleaned = prompt.replace(/<\|[a-z_]+\|>/gi, '').replace(/\s+$/, '');
        if (cleaned.length < 10 || seenPrompts.has(cleaned)) return;
        seenPrompts.add(cleaned);
        currentRound.prompts.push({
            id: String(Math.random()).slice(2),
            prompt: cleaned,
            source,
            imageUrls,
            fileIds: fileIds || [],
            selected: false,
            toolMsgId,
            lastAssistantMsgId,
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
            // 跳过 system context 等非真实用户消息
            const firstPart = parts?.[0];
            if (ct === 'user_editable_context') continue;
            currentRound = { roundIndex: rounds.length + 1, userText: '', prompts: [] };
            const up = typeof firstPart === 'string' ? firstPart.substring(0,40) : '';
            currentRound.userText = up;
            rounds.push(currentRound);
            lastAssistantMsgId = null;
        }

        // 跳过 system 角色
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
        if (dalle) {
            const rp = dalle.revised_prompt || (dalle.prompt?.length > 10 ? dalle.prompt : null);
            if (rp) addPrompt(rp, 'meta.dalle', [], msgId);
        }

        const igMeta = msg.metadata?.image_generation || msg.metadata?.image_gen_metadata;
        if (igMeta?.revised_prompt) addPrompt(igMeta.revised_prompt, 'ig_meta', [], msgId);

        const aggP = msg.metadata?.aggregate_result?.dalle?.prompts;
        if (Array.isArray(aggP)) for (const dp of aggP) {
            if (dp?.revised_prompt) addPrompt(dp.revised_prompt, 'agg', [], msgId);
        }
    }

    // 重新编号轮次（过滤空轮后）
    const filtered = rounds.filter(r => r.prompts.length > 0);
    filtered.forEach((r, i) => r.roundIndex = i + 1);
    return filtered;
}

function extractPromptsFromCode(codeText) {
    const prompts = [];
    const r1 = /prompt\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/g;
    let m;
    while ((m = r1.exec(codeText)) !== null) { const p=(m[1]||m[2]||'').trim(); if(p.length>20) prompts.push(p); }
    if (!prompts.length) {
        const r2 = /prompt\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
        while ((m = r2.exec(codeText)) !== null) { const p=(m[1]||m[2]||'').trim(); if(p.length>20) prompts.push(p); }
    }
    if (!prompts.length) {
        const r3 = /text2im\s*\(\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
        while ((m = r3.exec(codeText)) !== null) { const p=(m[1]||m[2]||m[3]||m[4]||'').trim(); if(p.length>20) prompts.push(p); }
    }
    return prompts;
}

// ===== 用 DOM 补充图片 URL =====
function enrichWithDomImages(rounds, conversationData) {
    const domImgs = getAllDomImages();
    log('🖼️ DOM 中找到图片数:', domImgs.length, domImgs.slice(0, 3));

    const allP = rounds.flatMap(r => r.prompts);
    const noImg = allP.filter(p => p.imageUrls.length === 0);
    if (!noImg.length && domImgs.length === 0) return;

    // 策略1: 用 file ID 从 API 数据重新匹配 DOM
    if (conversationData?.mapping) {
        for (const item of noImg) {
            if (!item.toolMsgId) continue;
            // 找到对应的 tool message
            for (const [, node] of Object.entries(conversationData.mapping)) {
                if (node?.message?.id === item.toolMsgId) {
                    const parts = node.message.content?.parts;
                    if (!Array.isArray(parts)) break;
                    const fileIds = extractFileIdsFromParts(parts);
                    for (const fid of fileIds) {
                        const domMatch = domImgs.find(url => url.includes(fid));
                        if (domMatch && !item.imageUrls.includes(domMatch)) {
                            item.imageUrls.push(domMatch);
                            log('🖼️ 延迟匹配 file ID:', fid);
                        }
                    }
                    break;
                }
            }
        }
    }

    // 策略2: 通过 data-message-id 在 DOM 中查找
    for (const item of allP.filter(p => p.imageUrls.length === 0)) {
        const tryIds = [item.toolMsgId, item.lastAssistantMsgId].filter(Boolean);
        for (const mid of tryIds) {
            const urls = getImagesFromDomByMsgId(mid);
            if (urls.length) { item.imageUrls = urls; break; }
        }
    }

    // 策略3: 按顺序分配剩余 DOM 图片
    if (domImgs.length > 0) {
        const usedUrls = new Set(allP.flatMap(p => p.imageUrls));
        const unusedDomImgs = domImgs.filter(u => !usedUrls.has(u));
        let idx = 0;
        for (const item of allP.filter(p => p.imageUrls.length === 0)) {
            if (idx < unusedDomImgs.length) {
                item.imageUrls = [unusedDomImgs[idx++]];
            }
        }
    }
}

// ===== API 主流程 =====
async function fetchAndExtractPrompts() {
    const convId = getConversationId();
    if (!convId) return;
    const token = getAccessToken();
    if (!token) { showStatus('无法获取 token'); return; }

    log('📡 请求对话数据:', convId);
    showStatus('正在获取对话数据...');

    try {
        const resp = await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) { showStatus('API错误: ' + resp.status); return; }
        const data = await resp.json();

        allRounds = buildRounds(data);
        seenPrompts.clear();
        allRounds.flatMap(r => r.prompts).forEach(p => seenPrompts.add(p.prompt));

        // 第一次尝试匹配图片
        enrichWithDomImages(allRounds, data);

        const total = allRounds.reduce((s,r) => s + r.prompts.length, 0);
        log(`✅ 提取 ${total} 个提示词，${allRounds.length} 轮对话`);
        showStatus(`找到 ${total} 个提示词 / ${allRounds.length} 轮`);

        renderPanel();

        // 延迟 3 秒再试一次 (等待 DOM 图片加载)
        const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
        if (noImgCount > 0) {
            log(`⏳ ${noImgCount} 个提示词无图片，3秒后重试DOM匹配...`);
            setTimeout(() => {
                enrichWithDomImages(allRounds, data);
                renderPanel();
                log('🔄 延迟图片匹配完成');
            }, 3000);
        }
    } catch(e) {
        log('❌', e.message); showStatus('请求失败: ' + e.message);
    }
}

// ===== 主循环 =====
let lastUrl = '';
function startMonitoring() {
    const checkUrl = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            allRounds = []; seenPrompts.clear();
            const body = document.getElementById('rp-body'); if (body) body.innerHTML = '';
            const panel = document.getElementById('rp-panel'); if (panel) panel.classList.remove('open');
            updateFab(); updateFooter();
            if (getConversationId()) setTimeout(() => fetchAndExtractPrompts(), 1500);
        }
    };
    setInterval(checkUrl, 1000);

    let debounce = null;
    const obs = new MutationObserver(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            const imgs = getAllDomImages();
            const total = allRounds.reduce((s,r) => s + r.prompts.length, 0);
            if (imgs.length > 0 && total === 0 && getConversationId()) fetchAndExtractPrompts();
            else if (imgs.length > 0 && total > 0) {
                // 检查是否有提示词还没图片
                const noImgCount = allRounds.flatMap(r => r.prompts).filter(p => p.imageUrls.length === 0).length;
                if (noImgCount > 0) { enrichWithDomImages(allRounds, null); renderPanel(); }
            }
        }, 3000);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    if (getConversationId()) {
        log('当前对话:', getConversationId());
        showStatus('正在获取对话数据...');
        fetchAndExtractPrompts();
    }
}

function boot() {
    log('🎨 v4.0 启动 (缩略图+多选+批量下载)');
    injectStyles(); createFab(); createPanel(); startMonitoring();
}

if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
})();
