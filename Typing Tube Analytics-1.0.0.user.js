// ==UserScript==
// @name         Typing Tube Analytics
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Typing Tubeのプレイ履歴を記録・分析・エクスポートするツール
// @author       Typing Tube User
// @match        https://typing-tube.net/movie/show/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=typing-tube.net
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- INITIALIZATION ---
    // 過去のローカルストレージデータをクリーンアップ（念のため）
    try {
        if (localStorage.getItem('ghost_standalone_history')) {
            localStorage.removeItem('ghost_standalone_history');
        }
    } catch(e) {}

    // --- CONFIGURATION ---
    const APP_PREFIX = 'tt-analytics'; // ID Prefix

    // --- STATE MANAGEMENT ---
    let sessionLogs = [];
    let currentLogs = [];
    let lastKeyTime = 0;
    let songTitle = "";
    let currentTextCache = "";
    let isRecording = false;

    // --- STYLES ---
    const style = document.createElement('style');
    style.textContent = `
        /* WRAPPER */
        #${APP_PREFIX}-wrapper { display: inline-block; position: relative; margin-right: 5px; vertical-align: middle; }

        /* ICON BUTTON */
        #${APP_PREFIX}-btn svg { fill: #888; transition: 0.2s; width: 24px; height: 24px; cursor: pointer; }
        #${APP_PREFIX}-btn:hover svg { fill: #007bff; transform: scale(1.1); filter: drop-shadow(0 0 2px rgba(0,123,255,0.5)); }

        /* STATE INDICATOR */
        #${APP_PREFIX}-btn.active svg { fill: #dc3545; animation: tt-pulse 2s infinite; }
        #${APP_PREFIX}-btn.menu-open svg { fill: #007bff; }

        /* DROPDOWN MENU */
        #${APP_PREFIX}-menu {
            display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
            background: #fff; border: 1px solid #ddd; border-radius: 6px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.15); padding: 4px;
            min-width: 140px; z-index: 10000; margin-bottom: 8px;
            flex-direction: column; gap: 1px;
            animation: tt-fade 0.1s ease-out;
        }
        #${APP_PREFIX}-menu.show { display: flex; }

        /* ARROW */
        #${APP_PREFIX}-menu::after {
            content: ''; position: absolute; bottom: -5px; left: 50%;
            width: 8px; height: 8px; background: #fff;
            border-right: 1px solid #ddd; border-bottom: 1px solid #ddd;
            transform: translateX(-50%) rotate(45deg);
        }

        /* MENU ITEM */
        .tt-item {
            padding: 8px 12px; font-size: 12px; color: #333; cursor: pointer;
            border-radius: 4px; transition: 0.1s; font-family: -apple-system, sans-serif;
            text-decoration: none; display: block; white-space: nowrap;
        }
        .tt-item:hover { background: #f0f7ff; color: #007bff; }

        /* NOTIFICATION */
        #${APP_PREFIX}-notify {
            position: fixed; bottom: 20px; left: 20px; background: #333; color: #fff; padding: 8px 16px;
            font-size: 12px; border-radius: 4px; opacity: 0; transition: 0.3s; pointer-events: none;
            transform: translateY(10px); z-index: 11000; font-family: sans-serif;
        }
        #${APP_PREFIX}-notify.show { opacity: 1; transform: translateY(0); }

        @keyframes tt-pulse { 0%{opacity:1} 50%{opacity:0.7} 100%{opacity:1} }
        @keyframes tt-fade { from{opacity:0; transform:translate(-50%, 5px)} to{opacity:1; transform:translate(-50%, 0)} }
    `;
    document.head.appendChild(style);

    // --- UI INJECTION ---
    function injectUI() {
        const gearIcon = document.querySelector('i.icon-cog-solid');
        if (!gearIcon) return;

        const gearBtn = gearIcon.closest('.btn');
        if (!gearBtn) return;

        const container = gearBtn.parentNode;
        if (!container || document.getElementById(`${APP_PREFIX}-wrapper`)) return;

        const wrapper = document.createElement('div');
        wrapper.id = `${APP_PREFIX}-wrapper`;
        wrapper.innerHTML = `
            <div id="${APP_PREFIX}-menu">
                <div class="tt-item" id="tt-action-preview">📊 プレビュー</div>
            </div>
            <a class="btn" id="${APP_PREFIX}-btn" title="Typing Analytics">
                <svg viewBox="0 0 24 24"><path d="M3 3v18h18v-2H5V3H3zm4 14h2v-7H7v7zm4 0h2V7h-2v10zm4 0h2v-4h-2v4z"></path></svg>
            </a>
        `;

        container.insertBefore(wrapper, gearBtn);

        const btn = document.getElementById(`${APP_PREFIX}-btn`);
        const menu = document.getElementById(`${APP_PREFIX}-menu`);

        // Toggle Menu
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('show');
            btn.classList.toggle('menu-open');
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) {
                menu.classList.remove('show');
                btn.classList.remove('menu-open');
            }
        });

        document.getElementById('tt-action-preview').onclick = () => {
            handlePreview();
            menu.classList.remove('show');
        };
    }

    const notify = document.createElement('div');
    notify.id = `${APP_PREFIX}-notify`;
    document.body.appendChild(notify);

    function updateIndicator() {
        const btn = document.getElementById(`${APP_PREFIX}-btn`);
        if (!btn) return;
        if (isRecording) btn.classList.add('active');
        else btn.classList.remove('active');
    }

    // --- DATA UTILS ---
    function getSongTitle() {
        const h1 = document.querySelector('.movietitle h1');
        if (!h1) return "Unknown Title";
        const clone = h1.cloneNode(true);
        const span = clone.querySelector('span');
        if (span) span.remove();
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    function getTextFromDOM() {
        const el = document.getElementById('kashi_roma');
        return el ? el.textContent.replace(/[\s\u3000\u200b・]/g, "").trim() : "";
    }

    function getMissCount() { return (parseInt(document.getElementById('miss-value')?.innerText, 10) || 0); }
    function getHitCount() { return (parseInt(document.getElementById('typing-count-value')?.innerText, 10) || 0); }

    function isTypingActive() {
        const t1 = document.getElementById('first-color-roma');
        const t2 = document.getElementById('typing-word-roma');
        return (t1?.textContent || "") + (t2?.textContent || "") !== "";
    }

    // --- CORE LOGIC ---
    function flushLogs(forcedText = null) {
        if (currentLogs.length === 0) return;
        const text = forcedText || currentTextCache || "UNKNOWN";

        // 重複チェック: 前の行と歌詞もログも完全に一致する場合は保存しない
        if (sessionLogs.length > 0) {
            const lastLog = sessionLogs[sessionLogs.length - 1];
            if (lastLog.text === text && JSON.stringify(lastLog.logs) === JSON.stringify(currentLogs)) {
                currentLogs = [];
                return;
            }
        }

        sessionLogs.push({ text: text, logs: [...currentLogs], timestamp: Date.now() });
        currentLogs = [];
    }

    // 歌詞変更の監視
    const lyricsObserver = new MutationObserver(() => {
        const newText = getTextFromDOM();
        if (!newText || newText === currentTextCache) return;
        if (currentTextCache.includes(newText)) return; // スクロールによる短縮は無視
        if (currentLogs.length > 0) flushLogs(currentTextCache);
        currentTextCache = newText;
    });

    // 入力リセットの監視
    const resetObserver = new MutationObserver(() => {
        const target = document.getElementById('correct-input-roma');
        if (target && target.textContent.trim() === "") {
            if (currentLogs.length > 0) flushLogs(currentTextCache);
        }
    });

    // キー入力監視
    window.addEventListener('keydown', (e) => {
        // F4リセット対応
        if (e.code === 'F4' || e.key === 'F4') {
            sessionLogs = []; currentLogs = []; return;
        }

        const key = e.key.toLowerCase();
        if (key.length > 1 && key !== " " && key !== "-") return;

        // ゲーム画面外判定
        if (!document.getElementById('kashi_area')) {
            if (isRecording) { isRecording = false; updateIndicator(); }
            if (sessionLogs.length > 0) sessionLogs = [];
            return;
        }

        // 録画開始
        if (sessionLogs.length === 0 && currentLogs.length === 0) {
            isRecording = true;
            updateIndicator();
            songTitle = getSongTitle();
            currentTextCache = getTextFromDOM();
        }

        const hitBefore = getHitCount(), missBefore = getMissCount(), now = Date.now();
        if (currentLogs.length === 0) lastKeyTime = now;
        let dt = (currentLogs.length === 0) ? 0 : (now - lastKeyTime);

        setTimeout(() => {
            const hitAfter = getHitCount(), missAfter = getMissCount();
            if (hitAfter > hitBefore || missAfter > missBefore) {
                lastKeyTime = now;
                currentLogs.push({ k: key, dt: dt, m: missAfter > missBefore ? 1 : 0 });
                if (!isTypingActive()) setTimeout(() => flushLogs(currentTextCache), 100);
            }
        }, 0);
    }, true);

    // 初期化チェック
    const checkReady = setInterval(() => {
        const kashi = document.getElementById('kashi_roma');
        const correct = document.getElementById('correct-input-roma');
        injectUI();
        if (kashi && correct) {
            clearInterval(checkReady);
            lyricsObserver.observe(kashi, { childList: true, subtree: true, characterData: true });
            resetObserver.observe(correct, { childList: true, subtree: true, characterData: true });
        }
    }, 1000);

    // --- PREVIEW HANDLER ---
    function handlePreview() {
        if (currentLogs.length > 0) flushLogs(currentTextCache);
        if (sessionLogs.length === 0) { alert("データがありません"); return; }

        const htmlContent = generateHTML(sessionLogs, songTitle, true);

        const win = window.open('', '_blank');
        if (win) {
            win.document.write(htmlContent);
            win.document.close();
        } else { alert("ポップアップを許可してください"); }
    }

    // --- HTML GENERATOR ---
    function generateHTML(logs, title, isPreview) {
        const jsonStr = JSON.stringify(logs);
        const saveBtnHTML = isPreview ?
            `<button class="btn-ui btn-save" id="btn-save">📥 打鍵ログ保存</button>` : '';

        // 保存ボタンの動作: 自分自身のHTMLからボタン要素を除去して保存する
        const saveScript = isPreview ? `
            document.getElementById('btn-save').onclick = () => {
                const clone = document.documentElement.cloneNode(true);
                const btn = clone.querySelector('#btn-save');
                if(btn) btn.remove();

                const b = new Blob(['<!DOCTYPE html>'+clone.outerHTML], {type: 'text/html'});
                const a = document.createElement('a');
                a.href = URL.createObjectURL(b);
                a.download = 'TypingLog_${title.replace(/\s/g, '_')}.html';
                a.click();
            };
        ` : '';

        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>Analysis: ${title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #f8f9fa; --panel: #ffffff; --border: #e9ecef; --text: #343a40; --sub: #6c757d; --primary: #007bff; --success: #28a745; --danger: #dc3545; }
        body { background: var(--bg); color: var(--text); font-family: 'Roboto', sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; }
        header { height: 70px; background: #fff; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; padding: 0 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.03); }
        .title h1 { font-size: 18px; margin: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
        .title span { color: var(--sub); font-size: 14px; margin-left: 10px; }
        .stats { display: flex; gap: 30px; }
        .stat { text-align: right; }
        .label { font-size: 11px; color: var(--sub); font-weight: bold; display: block; }
        .val { font-size: 24px; font-weight: 700; color: var(--primary); font-family: 'JetBrains Mono'; }
        #viewport { flex: 1; display: flex; overflow: hidden; }
        #list { flex: 1; overflow-y: auto; padding: 20px; }
        .list-header { display: grid; grid-template-columns: 60px 1fr 100px 100px 80px; padding: 0 20px 10px; font-size: 11px; font-weight: bold; color: var(--sub); }
        .th-right { text-align: right; }
        .row { background: #fff; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; padding: 15px 20px; display: grid; grid-template-columns: 60px 1fr 100px 100px 80px; align-items: center; transition: 0.1s; cursor: pointer; }
        .row:hover { box-shadow: 0 4px 15px rgba(0,0,0,0.05); transform: translateY(-1px); border-color: #dee2e6; }
        .row.active { border-left: 4px solid var(--primary); padding-left: 16px; }
        .r-id { color: var(--sub); font-weight: bold; font-size: 12px; }
        .r-text { font-weight: bold; font-size: 15px; }
        .r-stat { text-align: right; font-family: 'JetBrains Mono'; font-weight: bold; }
        .drawer { background: #f1f3f5; padding: 20px; border-radius: 0 0 8px 8px; margin-top: -10px; margin-bottom: 10px; display: none; border: 1px solid var(--border); border-top: none; }
        .row.active + .drawer { display: block; }
        .btn-ui { background: var(--primary); color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; text-decoration: none; }
        .btn-ui:hover { background: #0056b3; }
        .btn-save { background: #28a745; }
        .btn-save:hover { background: #218838; }
        .timeline { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 15px; }
        .key { width: 22px; text-align: center; position: relative; }
        .k-char { font-size: 10px; color: var(--sub); font-weight: bold; text-transform: uppercase; }
        .k-bar { width: 100%; height: 4px; border-radius: 2px; background: #dee2e6; position: relative; transition: 0.1s; }
        .key.playing .k-bar { background: #007bff !important; box-shadow: 0 0 8px rgba(0,123,255,0.5); }
        .key.playing::before { content: '▼'; position: absolute; top: -12px; left: 50%; transform: translateX(-50%); color: #007bff; font-size: 10px; font-weight: bold; animation: bounce 0.5s infinite; }
        @keyframes bounce { 0%, 100% { transform: translate(-50%, 0); } 50% { transform: translate(-50%, -3px); } }
        .k-bar:hover::after { content: attr(data-ms); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 2px 6px; font-size: 10px; border-radius: 3px; white-space: nowrap; margin-bottom: 5px; z-index: 100; }
    </style>
</head>
<body>
    <header>
        <div class="title"><h1>${title}</h1><span>ANALYTICS REPORT</span></div>
        <div style="display:flex; gap:20px; align-items:center;">
            ${saveBtnHTML}
            <div class="stats">
                <div class="stat"><span class="label">CORRECT KEYS</span><span class="val" id="g-keys">0</span></div>
                <div class="stat"><span class="label">ACCURACY</span><span class="val" id="g-acc">0%</span></div>
                <div class="stat"><span class="label">AVG SPEED</span><span class="val" id="g-avg">0.00</span></div>
            </div>
        </div>
    </header>
    <div id="viewport">
        <div id="list">
            <div class="list-header">
                <div>#</div>
                <div>歌詞 (かな)</div>
                <div class="th-right">速度 (KPS)</div>
                <div class="th-right">正確性</div>
                <div class="th-right">キー数</div>
            </div>
            <div id="container"></div>
        </div>
    </div>
    <script>
        const RAW = ${jsonStr};

        function init() {
            let tk = 0, tm = 0, td = 0;
            RAW.forEach(d => {
                const logs = d.logs;
                let dur = (logs.length > 1) ? logs.reduce((s,l) => s + l.dt, 0) : 0;
                d.miss = logs.filter(l => l.m).length;
                d.len = logs.length;
                d.cor = d.len - d.miss;
                d.kps = (dur > 0) ? (d.cor / (dur / 1000)) : 0;
                if (d.kps > 50) d.kps = 0;
                d.acc = (d.len > 0) ? (d.cor / d.len) * 100 : 0;
                tk += d.len;
                tm += d.miss;
                td += dur;
            });
            document.getElementById('g-keys').innerText = (tk - tm).toLocaleString();
            document.getElementById('g-acc').innerText = ((tk > 0 ? (tk - tm) / tk * 100 : 0).toFixed(1)) + '%';
            document.getElementById('g-avg').innerText = ((td > 0 ? (tk - tm) / (td / 1000) : 0).toFixed(2)) + ' KPS';

            render();
            ${saveScript}
        }

        function render() {
            const c = document.getElementById('container');
            c.innerHTML = '';
            RAW.forEach((d, i) => {
                const r = document.createElement('div');
                r.className = 'row';
                r.innerHTML = '<div class="r-id">' + (i + 1) + '</div>' +
                              '<div class="r-text">' + d.text + '</div>' +
                              '<div class="r-stat" style="color:#007bff">' + d.kps.toFixed(2) + '</div>' +
                              '<div class="r-stat" style="color:#28a745">' + d.acc.toFixed(1) + '%</div>' +
                              '<div class="r-stat">' + d.len + '</div>';

                const dr = document.createElement('div');
                dr.className = 'drawer';
                dr.id = 'tl-' + i;

                let h = '';
                d.logs.forEach(l => {
                    let col = l.m ? '#dc3545' : (l.dt < 60 ? '#28a745' : (l.dt > 160 ? '#ffc107' : '#adb5bd'));
                    h += '<div class="key"><div class="k-char">' + l.k + '</div>' +
                         '<div class="k-bar" style="background:' + col + ';height:' + Math.min(l.dt / 5, 30) + 'px" data-ms="' + Math.round(l.dt) + 'ms"></div></div>';
                });

                dr.innerHTML = '<button class="btn-ui" onclick="play(' + i + ')">▶ REPLAY SEQUENCE</button>' +
                               '<div class="timeline">' + h + '</div>';

                r.onclick = function() { r.classList.toggle('active'); };
                c.appendChild(r);
                c.appendChild(dr);
            });
        }

        function play(idx) {
            const drawer = document.getElementById('tl-' + idx);
            const keys = drawer.querySelectorAll('.key');
            let t = 0;

            // リセット
            const allKeys = document.querySelectorAll('.key.playing');
            for(let k of allKeys) k.classList.remove('playing');

            RAW[idx].logs.forEach((l, i) => {
                t += l.dt;
                setTimeout(() => {
                    if (i > 0) keys[i - 1].classList.remove('playing');
                    keys[i].classList.add('playing');
                }, t);
            });
        }

        init();
    </script>
</body>
</html>`;
    }
})();