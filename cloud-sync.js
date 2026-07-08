/**
 * CloudSync - 云端/本地同步模块（同源模式 v5，支持 内网穿透服务器 + GitHub 两种云端）
 *
 * 云端类型（config.active）：
 *   - 'local'  ：仅本机（不同步云端），读写走 /api/*
 *   - 'server' ：内网穿透服务器（家里常开电脑），读写走根路径，写需管理密码(x-admin-key)
 *   - 'github' ：GitHub 仓库（公开/私有均可），读走 raw/api，写走 GitHub API(PUT，需 Token)
 *
 * 合并语义（绝不丢数据）：
 *   - 客户线索：按 id 并集，同 id 取较新一条
 *   - 网站内容：按 updatedAt 后写覆盖，平局取本地
 *
 * 网页里【绝不】存放服务器密钥；GitHub Token 仅存于本机（浏览器 localStorage / 文件夹 data 文件）。
 */
const CloudSync = {
    _defaultWorker: '',

    config: {
        workerUrl: '',
        adminKey: '',
        authUser: '', // 花生壳/内网穿透隧道的「访问验证」账号（Basic Auth）
        authPass: '', // 花生壳/内网穿透隧道的「访问验证」密码（Basic Auth）
        github: { repo: '', branch: 'main', path: 'data/cloud-data.json', token: '', proxy: '' },
        active: 'local' // 'local' | 'server' | 'github'
    },

    init() {
        try {
            const saved = localStorage.getItem('lecang_sync_config');
            if (saved) {
                const p = JSON.parse(saved);
                this.config.workerUrl = p.workerUrl || '';
                this.config.adminKey = p.adminKey || '';
                this.config.authUser = p.authUser || '';
                this.config.authPass = p.authPass || '';
                this.config.github = Object.assign(
                    { repo: '', branch: 'main', path: 'data/cloud-data.json', token: '', proxy: '' },
                    p.github || {}
                );
                this.config.active = p.active || this._autoActive();
            } else {
                this.config.active = this._autoActive();
            }
        } catch (e) {
            this.config.active = this._autoActive();
        }
        this._refreshFromServer();
    },

    _autoActive() {
        const g = this.config.github || {};
        if (g.repo && g.token) return 'github';
        if (this.hasCloudServer()) return 'server';
        return 'local';
    },

    hasCloudServer() {
        return !!(this.config.workerUrl && this.config.workerUrl.indexOf('http') === 0);
    },
    hasGitHub() {
        const g = this.config.github || {};
        return !!(g.repo && g.token);
    },

    // 当前生效的云端类型（active 失效时自动回退）
    getMode() {
        const a = this.config.active;
        if (a === 'github') return this.hasGitHub() ? 'github' : 'local';
        if (a === 'server') return this.hasCloudServer() ? 'server' : 'local';
        return 'local';
    },
    hasCloud() { return this.getMode() !== 'local'; },
    isConfigured() { return this.getMode() !== 'local'; },

    async _refreshFromServer() {
        try {
            const r = await fetch('/api/sync-config', { signal: this._timeoutSignal(5000) });
            if (!r.ok) return;
            const j = await r.json();
            if (!j || !j.success || !j.data) return;
            const d = j.data;
            // server 端 github 默认值补全（含 proxy）
            const srvGithub = Object.assign(
                { repo: '', branch: 'main', path: 'data/cloud-data.json', token: '', proxy: '' },
                d.github || {}
            );
            let changed = false;
            if ((d.workerUrl || '') !== this.config.workerUrl) changed = true;
            if ((d.adminKey || '') !== this.config.adminKey) changed = true;
            if ((d.authUser || '') !== this.config.authUser) changed = true;
            if ((d.authPass || '') !== this.config.authPass) changed = true;
            // GitHub 合并策略：server 端有实质数据（repo+token）才覆盖本地；否则保留本地已有配置
            const lg = this.config.github || {};
            const srvHasGithub = !!(srvGithub.repo && srvGithub.token);
            const localHasGithub = !!(lg.repo || lg.token);
            if (srvHasGithub && localHasGithub) {
                if (
                    srvGithub.repo !== (lg.repo || '') || srvGithub.token !== (lg.token || '') ||
                    (srvGithub.branch || 'main') !== (lg.branch || 'main') ||
                    (srvGithub.path || 'data/cloud-data.json') !== (lg.path || 'data/cloud-data.json') ||
                    (srvGithub.proxy || '') !== (lg.proxy || '')
                ) changed = true;
            } else if (srvHasGithub && !localHasGithub) {
                changed = true;  // server 有、本地无 → 用 server 的
            }
            // else: server 无、本地有 → 保持本地不变（不覆盖！）
            const srvActive = d.active || this._autoActive();
            if (srvActive !== this.config.active) changed = true;

            if (changed) {
                this.config.workerUrl = d.workerUrl || '';
                this.config.adminKey = d.adminKey || '';
                this.config.authUser = d.authUser || '';
                this.config.authPass = d.authPass || '';
                if (srvHasGithub) {
                    this.config.github = srvGithub;
                }
                // localHasGithub && !srvHasGithub 时保持 this.config.github 不变
                this.config.active = srvActive;
                localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
                this._notifyRefreshed();
            }
            // 若本地有 github 而 server 无，把本地数据同步到 server 防下次再覆盖
            if (!srvHasGithub && localHasGithub) {
                this._persistServer();
            }
        } catch (e) { /* 无本地服务器（如 GitHub Pages / file://）→ 用浏览器本地存储，忽略 */ }
    },

    _persistServer() {
        fetch('/api/sync-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.config)
        }).catch(() => {});
    },

    _notifyRefreshed() {
        if (typeof window !== 'undefined' && typeof window.__lecangOnConfigRefreshed === 'function') {
            window.__lecangOnConfigRefreshed();
        }
    },

    // 服务器云端配置（保持旧签名：setConfig(workerUrl, adminKey)）
    setConfig(workerUrl, adminKey) {
        this.config.workerUrl = (workerUrl || '').replace(/\/+$/, '');
        this.config.adminKey = adminKey || '';
        this.config.active = this.config.workerUrl ? 'server' : (this.hasGitHub() ? 'github' : 'local');
        localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
        this._persistServer();
    },

    // 花生壳/内网穿透隧道的「访问验证」凭据（HTTP Basic Auth），与 setConfig 分开以便单独设置
    setServerAuth(user, pass) {
        this.config.authUser = (user || '').trim();
        this.config.authPass = pass || '';
        localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
        this._persistServer();
    },

    // GitHub 云端配置
    setGitHubConfig(repo, branch, path, token, proxy) {
        this.config.github = {
            repo: (repo || '').trim(),
            branch: (branch || 'main').trim() || 'main',
            path: (path || 'data/cloud-data.json').trim() || 'data/cloud-data.json',
            token: (token || '').trim(),
            proxy: (proxy || '').trim()
        };
        this.config.active = (this.config.github.repo && this.config.github.token)
            ? 'github'
            : (this.hasCloudServer() ? 'server' : 'local');
        localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
        this._persistServer();
    },

    // 仅切换当前生效的云端类型（不改变已保存的配置）
    setActive(mode) {
        this.config.active = mode;
        localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
        this._persistServer();
    },

    getConfig() { return JSON.parse(JSON.stringify(this.config)); },

    // 根据当前云端类型选择 base 与路径前缀
    _base() {
        if (this.getMode() !== 'server') return '';
        const w = this.config.workerUrl || '';
        if (!w) return '';
        // 同源优先：若后台页面与云端地址是同一台服务器（同一域名/主机），
        // 直接用相对路径，避免浏览器从内网去访问外网域名时因路由器 NAT 回环未开启而失败。
        try {
            const wHost = new URL(w).host;
            if (wHost && wHost === location.host) return '';
        } catch (e) {}
        return w;
    },
    _contentPath() { return this.getMode() === 'server' ? '/content' : '/api/content'; },
    _subsPath() { return this.getMode() === 'server' ? '/submissions' : '/api/submissions'; },
    _submitPath() { return this.getMode() === 'server' ? '/submit' : '/api/submit'; },
    _adminForWrite() { return this.getMode() === 'server'; },

    _headers(admin) {
        const h = { 'Content-Type': 'application/json' };
        // 同源后台由 server 注入的管理密钥（优先）；存在时才带，公网 GitHub Pages 静态后台无注入不影响。
        const injected = (typeof window !== 'undefined') ? window.__LECANG_ADMIN_KEY__ : undefined;
        if (injected && injected.length >= 8) h['x-admin-key'] = injected;
        else if (admin && this.config && this.config.adminKey) h['x-admin-key'] = this.config.adminKey;
        // 若内网穿透隧道开启了「访问验证」（HTTP Basic Auth，如部分付费/企业隧道才有；花生壳免费版默认没有），
        // fetch 不会弹窗也不会自动带凭据，必须在这里自动带上，否则请求会被 401 挡掉。一般留空即可。
        if (this.getMode() === 'server' && (this.config.authUser || this.config.authPass)) {
            const raw = (this.config.authUser || '') + ':' + (this.config.authPass || '');
            try {
                h['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(raw)));
            } catch (e) {
                h['Authorization'] = 'Basic ' + btoa(raw);
            }
        }
        return h;
    },

    async _req(base, method, path, body, admin) {
        const attempt = async (b) => {
            const url = (b || '') + path;
            const ctrl = this._timeoutController(15000);
            const fetchOpts = {
                method,
                headers: this._headers(admin),
                body: body ? JSON.stringify(body) : undefined
            };
            if (ctrl) fetchOpts.signal = ctrl.signal;
            try {
                const resp = await fetch(url, fetchOpts);
                this._clearTimeout(ctrl);
                if (resp.status === 401 || resp.status === 403) return { __auth: true };
                if (!resp.ok) {
                    let detail = '';
                    try { detail = (await resp.json()).error || ''; } catch (e) {}
                    return { __err: '云端返回 ' + resp.status + (detail ? '：' + detail : '') };
                }
                const data = await resp.json().catch(() => ({}));
                return { __ok: true, data };
            } catch (e) {
                this._clearTimeout(ctrl);
                return { __net: true };
            }
        };
        const first = await attempt(base);
        if (first.__ok) return { success: true, data: first.data };
        if (first.__auth) return { success: false, error: '管理密码错误或无权限' };
        if (first.__err) return { success: false, error: first.__err };
        // 网络失败：若用了绝对云端地址且页面与云端非同源，回退到同源相对地址再试一次，
        // 绕开家里路由器 NAT 回环未开启、或外网域名临时不可达导致的“假失败”。
        if (base) {
            const fb = await attempt('');
            if (fb.__ok) return { success: true, data: fb.data };
            if (fb.__auth) return { success: false, error: '管理密码错误或无权限' };
            if (fb.__err) return { success: false, error: fb.__err };
        }
        const isLocal = !base;
        const msg = isLocal
            ? '本机服务器未连接（请先双击「启动网站.bat」启动本地服务器）'
            : '无法连接云端：家里电脑服务器可能未启动，或花生壳/内网穿透隧道已断开（请在家里电脑双击「启动网站.bat」并保持隧道在线）';
        return { success: false, error: msg };
    },

    _extractContent(d) {
        if (!d) return null;
        if (d.content) return d.content;
        if (d.data) return d.data;
        return d;
    },
    _extractSubs(d) {
        if (!d) return [];
        if (Array.isArray(d)) return d;
        if (Array.isArray(d.submissions)) return d.submissions;
        if (Array.isArray(d.data)) return d.data;
        return [];
    },

    // 判断内容对象是否含“实质内容”（排除 updatedAt 等元数据）
    _hasRealContent(obj) {
        if (!obj || typeof obj !== 'object') return false;
        return Object.keys(obj).filter(k => k !== 'updatedAt').length > 0;
    },
    // 浏览器兼容的超时控制器（避免旧浏览器 AbortSignal.timeout 报错导致请求“假失败”伪装成“无法连接云端”）
    _timeoutController(ms) {
        try {
            if (typeof AbortController === 'undefined') return null;
            const c = new AbortController();
            c.__timer = setTimeout(() => { try { c.abort(); } catch (e) {} }, ms);
            return c;
        } catch (e) { return null; }
    },
    _clearTimeout(c) { if (c && c.__timer) { try { clearTimeout(c.__timer); } catch (e) {} } },
    // 返回超时信号（旧浏览器无 AbortSignal.timeout 时降级为 undefined）
    _timeoutSignal(ms) {
        const c = this._timeoutController(ms);
        return c ? c.signal : undefined;
    },

    // ===== 本机服务器读写（/api/*）=====
    async readLocalContent() {
        const r = await this._req('', 'GET', '/api/content', null, false);
        if (!r.success) return null;
        return this._extractContent(r.data);
    },
    async readLocalSubs() {
        const r = await this._req('', 'GET', '/api/submissions', null, false);
        if (!r.success) return null;
        return this._extractSubs(r.data);
    },
    async writeLocalContent(c) { return this._req('', 'POST', '/api/content', c, false); },
    async writeLocalSubs(s) { return this._req('', 'POST', '/api/submissions-replace', s, false); },

    // ===== 内网穿透服务器读写（根路径，写需密钥）=====
    async readCloudContent() {
        const r = await this._req(this._base(), 'GET', '/content', null, false);
        if (!r.success) return null;
        return this._extractContent(r.data);
    },
    async readCloudSubs() {
        const r = await this._req(this._base(), 'GET', '/submissions', null, true);
        if (!r.success) return null;
        return this._extractSubs(r.data);
    },
    async writeCloudContent(c) { return this._req(this._base(), 'POST', '/content', c, true); },
    async writeCloudSubs(s) { return this._req(this._base(), 'POST', '/submissions-replace', s, true); },

    // ===== GitHub 云端读写 =====
    _ghApiUrl() {
        const g = this.config.github;
        return this.githubProxyUrl('https://api.github.com/repos/' + g.repo + '/contents/' + (g.path || 'data/cloud-data.json'));
    },
    _ghRawUrl() {
        const g = this.config.github;
        return this.githubProxyUrl('https://raw.githubusercontent.com/' + g.repo + '/' + (g.branch || 'main') + '/' + (g.path || 'data/cloud-data.json'));
    },
    // 国内网络常连不上 api.github.com / raw.githubusercontent.com，可填一个 GitHub 代理/镜像
    // 把请求转发过去。格式如 https://ghproxy.net （会自动拼成 https://ghproxy.net/https://api.github.com/...）
    githubProxyUrl(u) {
        const p = ((this.config.github && this.config.github.proxy) || '').trim().replace(/\/+$/, '');
        return p ? p + '/' + u : u;
    },
    _b64encode(str) {
        const utf8 = new TextEncoder().encode(str);
        let bin = '';
        utf8.forEach(b => bin += String.fromCharCode(b));
        return btoa(bin);
    },
    _b64decode(b64) {
        const bin = atob((b64 || '').replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    },
    _ghHeaders() {
        const h = {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.config.github.token) h['Authorization'] = 'Bearer ' + this.config.github.token;
        return h;
    },
    async readGitHubRaw() {
        const g = this.config.github;
        const apiUrl = this._ghApiUrl();
        const apiHeaders = this._ghHeaders(); // 有 Token 自动带上 Authorization
        // 优先走 api.github.com（CORS 友好、数据最新）；公开仓库无需 Token 也能读
        try {
            const r = await fetch(apiUrl, { headers: apiHeaders, signal: this._timeoutSignal(15000) });
            if (r.status === 404) return null;
            if (r.ok) {
                const j = await r.json();
                const content = (j.content) ? this._b64decode(j.content) : '{}';
                let data; try { data = JSON.parse(content); } catch (e) { data = {}; }
                return data;
            }
            // api 可达但报错：公开仓库无 Token 时再试 raw / jsDelivr 兜底
            if (!g.token) {
                const fb = await this._readGitHubFallback();
                if (fb !== undefined) return fb;
                return { success: false, error: 'GitHub 读取失败 ' + r.status + '（公开仓库读取失败，可尝试填写 Token，或检查仓库/分支/路径）' };
            }
            return { success: false, error: 'GitHub 读取失败 ' + r.status + '（请检查 Token 是否有 repo 权限、仓库/分支/路径是否正确）' };
        } catch (e) {
            // 网络层失败（国内常连不上 api.github.com）：公开仓库无 Token 时走 raw / jsDelivr
            if (!g.token) {
                const fb = await this._readGitHubFallback();
                if (fb !== undefined) return fb;
            }
            const tip = g.proxy
                ? '（已配置代理但仍失败，请换一个可用的代理/镜像地址）'
                : '（你的网络可能连不上 api.github.com：可在「云端设置→GitHub」填「代理/镜像地址」如 https://ghproxy.net，或改用内网穿透服务器云端）';
            return { success: false, error: 'GitHub 网络错误：' + e.message + tip };
        }
    },
    // 公开仓库无 Token 时的读取兜底：依次试 raw.githubusercontent.com → jsDelivr CDN（国内通常可达）
    async _readGitHubFallback() {
        const g = this.config.github;
        const sources = [
            this._ghRawUrl(),
            'https://cdn.jsdelivr.net/gh/' + g.repo + '@' + (g.branch || 'main') + '/' + (g.path || 'data/cloud-data.json')
        ];
        for (const u of sources) {
            try {
                const r = await fetch(u, { signal: this._timeoutSignal(12000) });
                if (r.status === 404) continue;
                if (r.ok) {
                    const j = await r.json().catch(() => ({}));
                    if (j && j.success === false) continue;
                    return j;
                }
            } catch (e2) {}
        }
        return undefined;
    },
    _safeRaw(raw) {
        return (raw && raw.success !== false) ? raw : {};
    },
    async readGitHubContent() {
        const d = this._safeRaw(await this.readGitHubRaw());
        return (d && d.content) ? d.content : d;
    },
    async readGitHubSubs() {
        const d = this._safeRaw(await this.readGitHubRaw());
        return (d && Array.isArray(d.submissions)) ? d.submissions : [];
    },
    // 写入候选地址：优先用户配置的代理；未配置时直连 api.github.com，失败再走公共镜像
    _ghWriteCandidates() {
        const api = 'https://api.github.com/repos/' + (this.config.github.repo || '') + '/contents/' + (this.config.github.path || 'data/cloud-data.json');
        const cfgProxy = (this.config.github.proxy || '').trim().replace(/\/+$/, '');
        if (cfgProxy) return [cfgProxy + '/' + api];
        return [api, 'https://ghproxy.net/' + api, 'https://gh.api.99988866.xyz/' + api];
    },
    async writeGitHub(payload) {
        const g = this.config.github;
        if (!g.token) return { success: false, error: 'GitHub 写入需要 Token（在云端设置中填写）' };
        const encoded = this._b64encode(JSON.stringify(payload, null, 2));
        let lastErr = '';
        for (const url of this._ghWriteCandidates()) {
            try {
                // 取当前文件 SHA（不存在则为新建）
                let sha = null;
                try {
                    const r0 = await fetch(url, { headers: this._ghHeaders(), signal: this._timeoutSignal(15000) });
                    if (r0.ok) { const j = await r0.json(); sha = j.sha || null; }
                } catch (e) {}
                const r = await fetch(url, {
                    method: 'PUT',
                    headers: this._ghHeaders(),
                    body: JSON.stringify({
                        message: '更新乐藏云端数据 ' + new Date().toISOString(),
                        content: encoded,
                        sha: sha || undefined
                    }),
                    signal: this._timeoutSignal(20000)
                });
                if (r.ok) return { success: true };
                let msg = '';
                try { msg = (await r.json()).message || ''; } catch (e) {}
                if (r.status === 401 || r.status === 403) {
                    return { success: false, error: 'GitHub 写入失败 ' + r.status + '：Token 无写入权限（需 repo 权限或细粒度 Contents:Write）' + (msg ? ' ' + msg : '') };
                }
                lastErr = 'GitHub 写入失败 ' + r.status + (msg ? '：' + msg : '');
            } catch (e) {
                lastErr = 'GitHub 网络错误：' + e.message + '（已尝试代理/镜像仍失败，可手动在「云端设置→GitHub」填写可用的代理地址）';
            }
        }
        return { success: false, error: lastErr };
    },
    async writeGitHubContent(c) {
        const d = this._safeRaw(await this.readGitHubRaw());
        // 把内联的 base64 图片抽取成仓库文件，避免 cloud-data.json 被撑爆且公网能正常显示
        const finalContent = await this._extractAndUploadInlineImages(c || {});
        d.content = finalContent;
        if (!Array.isArray(d.submissions)) d.submissions = [];
        d.updatedAt = Date.now();
        const r = await this.writeGitHub(d);
        // 同时把最新内容内联进 index.html（消除首屏默认模板闪烁）
        await this.writeGitHubIndex(finalContent);
        return r;
    },
    // GitHub 后台直接上传的图片以 base64 暂存在内容里；这里把它们抽取成仓库文件
    // data/uploads/xxx，并把内容里的值改写为 /data/uploads/xxx 的 URL，保证公网可见。
    async _extractAndUploadInlineImages(content) {
        if (!content || typeof content !== 'object') return content;
        const g = this.config.github;
        if (!g || !g.token || !g.repo) return content; // 无 token 无法上传，保留 base64（至少本地可见）
        for (const k of Object.keys(content)) {
            const v = content[k];
            if (typeof v !== 'string') continue;
            const m = v.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
            if (!m) continue;
            const ext = (m[1] === 'jpeg' ? 'jpg' : m[1]).toLowerCase();
            const b64 = m[2];
            const fname = 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
            const api = 'https://api.github.com/repos/' + g.repo + '/contents/data/uploads/' + fname;
            const candidates = (g.proxy || '').trim().replace(/\/+$/, '')
                ? [(g.proxy.replace(/\/+$/, '') + '/' + api)]
                : [api, 'https://ghproxy.net/' + api, 'https://gh.api.99988866.xyz/' + api];
            let ok = false;
            for (const url of candidates) {
                try {
                    const r = await fetch(url, {
                        method: 'PUT',
                        headers: this._ghHeaders(),
                        body: JSON.stringify({ message: '上传图片 ' + fname, content: b64, sha: undefined }),
                        signal: this._timeoutSignal(20000)
                    });
                    if (r.ok) { ok = true; break; }
                } catch (e) { /* 试下一个候选地址 */ }
            }
            if (ok) content[k] = '/data/uploads/' + fname;
            // 上传失败则保留 base64（至少本地预览可见），不阻断保存
        }
        return content;
    },
    async writeGitHubSubs(s) {
        const d = this._safeRaw(await this.readGitHubRaw());
        d.submissions = s || [];
        if (!d.content) d.content = {};
        d.updatedAt = Date.now();
        return this.writeGitHub(d);
    },
    async addGitHubSubmission(sub) {
        const d = this._safeRaw(await this.readGitHubRaw());
        const subs = Array.isArray(d.submissions) ? d.submissions : [];
        subs.unshift(sub);
        d.submissions = subs;
        if (!d.content) d.content = {};
        d.updatedAt = Date.now();
        return this.writeGitHub(d);
    },
    async deleteGitHubSubmission(id) {
        const d = this._safeRaw(await this.readGitHubRaw());
        d.submissions = (Array.isArray(d.submissions) ? d.submissions : []).filter(s => String(s.id) !== String(id));
        if (!d.content) d.content = {};
        d.updatedAt = Date.now();
        return this.writeGitHub(d);
    },
    async clearGitHubSubmissions() {
        const d = this._safeRaw(await this.readGitHubRaw());
        d.submissions = [];
        if (!d.content) d.content = {};
        d.updatedAt = Date.now();
        return this.writeGitHub(d);
    },

    // 把最新内容内联进仓库的 index.html（仅在模板含 lecang-content-embed 标记时生效）
    _ghIndexCandidates() {
        const api = 'https://api.github.com/repos/' + (this.config.github.repo || '') + '/contents/index.html';
        const cfgProxy = (this.config.github.proxy || '').trim().replace(/\/+$/, '');
        if (cfgProxy) return [cfgProxy + '/' + api];
        return [api, 'https://ghproxy.net/' + api, 'https://gh.api.99988866.xyz/' + api];
    },
    async writeGitHubIndex(content) {
        const g = this.config.github;
        if (!g.token) return { success: false };
        let lastErr = '';
        for (const url of this._ghIndexCandidates()) {
            try {
                let sha = null, cur = null;
                try {
                    const r0 = await fetch(url, { headers: this._ghHeaders(), signal: this._timeoutSignal(15000) });
                    if (r0.ok) { const j = await r0.json(); sha = j.sha || null; cur = j.content || ''; }
                } catch (e) {}
                let html = cur ? this._b64decode(cur) : null;
                if (html == null) {
                    // 仓库暂无 index.html（极少），尝试取当前页作为模板
                    try { const rr = await fetch('./index.html', { signal: this._timeoutSignal(15000) }); if (rr.ok) html = await rr.text(); } catch (e) {}
                }
                if (html == null || html.indexOf('lecang-content-embed') === -1) return { success: true };
                const injected = html.replace(/<script id="lecang-content-embed"[^>]*>[\s\S]*?<\/script>/,
                    '<script id="lecang-content-embed" type="application/json">' + JSON.stringify(content || {}) + '</script>');
                if (injected === html) return { success: true };
                const r = await fetch(url, {
                    method: 'PUT',
                    headers: this._ghHeaders(),
                    body: JSON.stringify({ message: '内联最新内容到 index.html ' + new Date().toISOString(), content: this._b64encode(injected), sha: sha || undefined }),
                    signal: this._timeoutSignal(20000)
                });
                if (r.ok) return { success: true };
                let msg = ''; try { msg = (await r.json()).message || ''; } catch (e) {}
                lastErr = 'index.html 写入失败 ' + r.status + (msg ? '：' + msg : '');
            } catch (e) { lastErr = 'index.html 网络错误：' + e.message; }
        }
        return { success: false, error: lastErr };
    },
    // ===== 统一分发（按当前云端类型）=====
    async readContent() {
        const m = this.getMode();
        if (m === 'github') return this.readGitHubContent();
        if (m === 'server') return this.readCloudContent();
        return this.readLocalContent();
    },
    async writeContent(c) {
        const m = this.getMode();
        if (m === 'github') return this.writeGitHubContent(c);
        if (m === 'server') return this.writeCloudContent(c);
        return this.writeLocalContent(c);
    },
    async readSubmissions() {
        const m = this.getMode();
        if (m === 'github') return this.readGitHubSubs();
        if (m === 'server') return this.readCloudSubs();
        return this.readLocalSubs();
    },
    async writeSubmissions(s) {
        const m = this.getMode();
        if (m === 'github') return this.writeGitHubSubs(s);
        if (m === 'server') return this.writeCloudSubs(s);
        return this.writeLocalSubs(s);
    },
    async addSubmission(submission) {
        const m = this.getMode();
        if (m === 'github') return this.addGitHubSubmission(submission);
        return this._req(this._base(), 'POST', this._submitPath(), submission, false);
    },
    async deleteSubmission(id) {
        const m = this.getMode();
        if (m === 'github') return this.deleteGitHubSubmission(id);
        return this._req(this._base(), 'DELETE', this._subsPath() + '/' + encodeURIComponent(id), null, this._adminForWrite());
    },
    async clearSubmissions() {
        const m = this.getMode();
        if (m === 'github') return this.clearGitHubSubmissions();
        return this._req(this._base(), 'POST', this._subsPath().replace(/submissions$/, 'clear-submissions'), null, this._adminForWrite());
    },

    // ===== 合并策略（核心：绝不丢数据）=====
    mergeContent(local, cloud) {
        const lt = local && local.updatedAt ? local.updatedAt : 0;
        const ct = cloud && cloud.updatedAt ? cloud.updatedAt : 0;
        if (ct > lt) return { content: cloud, source: '云端' };
        return { content: (local || cloud), source: '本地' };
    },
    mergeSubs(local, cloud) {
        const map = new Map();
        const all = [...(local || []), ...(cloud || [])];
        for (const s of all) {
            const id = (s && s.id != null) ? String(s.id)
                : ('_' + (s.timestamp || 0) + '_' + (s.phone || '') + '_' + (s.wechat || ''));
            const prev = map.get(id);
            if (!prev) { map.set(id, s); continue; }
            const pt = prev.timestamp || 0, ct = s.timestamp || 0;
            map.set(id, ct >= pt ? s : prev);
        }
        return [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    },

    // ===== 双向同步核心 =====
    async syncBidirectional(direction) {
        direction = direction || 'both';
        if (this.getMode() === 'github') return this._syncGitHub(direction);

        // —— 内网穿透服务器 / 本机 模式 ——
        if (!this.hasCloudServer()) {
            return { success: false, error: '未配置云端地址。请在「云端设置」中填入家里常开电脑的内网穿透地址，或切换到 GitHub 云端。' };
        }
        // “仅上传(up)”只需读云端【线索】用于合并去重，不必读云端【内容】——
        // 本地为权威，既避免慢，也避免“云端较新”回写覆盖本地修改。
        const reads = [
            this.readLocalContent(), this.readLocalSubs(),
            (direction === 'up' ? Promise.resolve(null) : this.readCloudContent()),
            this.readCloudSubs()
        ];
        const [lc, ls, cc, cs] = await Promise.all(reads);
        if (lc === null && cc === null) return { success: false, error: '无法读取本地与云端数据' };
        // 仅“下载”必须云端可读；“双向”在云端读不到时退化为仅上传本地，保证保存/发布不中断
        if (direction === 'down' && cc === null) {
            return { success: false, error: '无法连接云端，请检查云端地址和管理密码是否正确' };
        }
        if (direction === 'both' && cc === null) {
            console.warn('[lecang] 云端读取失败，双向同步退化为仅上传本地内容');
        }

        const localContent = lc || {};
        const cloudContent = cc || {};
        const localSubs = ls || [];
        const cloudSubs = cs || [];

        // 方向敏感合并：
        //  - 仅上传(up)：本地为权威，直接用本地内容（云端较新也绝不回写覆盖本地）
        //  - 下载/双向：按 updatedAt 较新者胜出
        const mergedContent = (direction === 'up')
            ? (this._hasRealContent(localContent) ? localContent : {})
            : this.mergeContent(localContent, cloudContent).content;
        const mergedSubs = this.mergeSubs(localSubs, cloudSubs);

        const errors = [];
        if (direction === 'up' || direction === 'both') {
            // 关键防护：本地内容为空时，绝不用 {} 覆盖云端真实内容
            if (this._hasRealContent(localContent)) {
                const wc = await this.writeCloudContent(mergedContent);
                if (!wc.success) errors.push('云端内容：' + wc.error);
            } else {
                console.warn('[lecang] 本地内容为空，跳过上传，避免清空云端');
            }
            const ws = await this.writeCloudSubs(mergedSubs);
            if (!ws.success) errors.push('云端线索：' + ws.error);
        }
        if (direction === 'down' || direction === 'both') {
            const wl = await this.writeLocalContent(mergedContent);
            const wsl = await this.writeLocalSubs(mergedSubs);
            if (!wl.success) errors.push('本地内容：' + wl.error);
            if (!wsl.success) errors.push('本地线索：' + wsl.error);
        }

        const ok = errors.length === 0;
        const ts = this._nowStr();
        localStorage.setItem('lecang_cloud_lastsync', ts);
        return {
            success: ok, error: ok ? '' : errors.join('；'),
            mergedSubmissions: mergedSubs.length,
            localSubmissions: localSubs.length,
            cloudSubmissions: cloudSubs.length,
            contentSource: this.mergeContent(localContent, cloudContent).source,
            syncTime: ts
        };
    },

    async _syncGitHub(direction) {
        direction = direction || 'both';
        if (!this.hasGitHub()) return { success: false, error: '未配置 GitHub 云端（仓库 / Token）' };
        const [lc, ls, cc, cs] = await Promise.all([
            this.readLocalContent(), this.readLocalSubs(),
            this.readGitHubContent(), this.readGitHubSubs()
        ]);
        if (cc === null && cs === null) return { success: false, error: '无法读取 GitHub 数据，请检查仓库、分支、路径和 Token（需 repo 权限）' };

        const localContent = lc || {};
        const cloudContent = cc || {};
        const localSubs = ls || [];
        const cloudSubs = cs || [];
        const mergedContent = this.mergeContent(localContent, cloudContent).content;
        const mergedSubs = this.mergeSubs(localSubs, cloudSubs);

        const errors = [];
        if (direction === 'up' || direction === 'both') {
            const w = await this.writeGitHub({ content: mergedContent, submissions: mergedSubs, updatedAt: Date.now() });
            if (!w.success) errors.push('GitHub：' + w.error);
        }
        if (direction === 'down' || direction === 'both') {
            const localAvailable = (lc !== null || ls !== null);
            if (localAvailable) {
                const wl = await this.writeLocalContent(mergedContent);
                const wsl = await this.writeLocalSubs(mergedSubs);
                if (!wl.success) errors.push('本地内容：' + wl.error);
                if (!wsl.success) errors.push('本地线索：' + wsl.error);
            }
            // 始终更新本地浏览器缓存（离线回退）
            this.setContent(mergedContent);
            this.setSubmissions(mergedSubs);
        }

        const ok = errors.length === 0;
        const ts = this._nowStr();
        localStorage.setItem('lecang_cloud_lastsync', ts);
        return {
            success: ok, error: ok ? '' : errors.join('；'),
            mergedSubmissions: mergedSubs.length,
            localSubmissions: localSubs.length,
            cloudSubmissions: cloudSubs.length,
            contentSource: this.mergeContent(localContent, cloudContent).source,
            syncTime: ts
        };
    },

    async syncToCloud(contentData, submissionsData) {
        // 兼容旧接口：上传到当前云端（合并，不覆盖）
        if (this.getMode() === 'github') {
            const cloudSubs = await this.readGitHubSubs();
            const localSubs = submissionsData || (await this.readLocalSubs()) || [];
            const merged = this.mergeSubs(localSubs, cloudSubs || []);
            const wc = await this.writeGitHubContent(contentData || (await this.readLocalContent()) || {});
            const ws = await this.writeGitHubSubs(merged);
            await this.writeLocalSubs(merged);
            const ok = wc.success && ws.success;
            return { success: ok, results: { content: wc.success, submissions: ws.success }, error: ok ? '' : [!wc.success && wc.error, !ws.success && ws.error].filter(Boolean).join('；') };
        }
        if (!this.hasCloudServer()) {
            let c = true, s = true;
            if (contentData) c = (await this.writeLocalContent(contentData)).success;
            if (submissionsData) s = (await this.writeLocalSubs(submissionsData)).success;
            return { success: c && s, results: { content: c, submissions: s } };
        }
        const cloudSubs = await this.readCloudSubs();
        const localSubs = submissionsData || (await this.readLocalSubs()) || [];
        const merged = this.mergeSubs(localSubs, cloudSubs || []);
        // 防护：绝不用空内容 {} 去覆盖云端真实数据
        const effectiveContent = this._hasRealContent(contentData)
            ? contentData
            : (await this.readLocalContent());
        let wc = { success: true };
        if (this._hasRealContent(effectiveContent)) {
            wc = await this.writeCloudContent(effectiveContent);
            // 同步固化到本机服务器，保证“本地”也是最新（避免本机服务端仍是旧内容被后续误读）
            await this.writeLocalContent(effectiveContent);
        } else {
            console.warn('[lecang] 上传内容为空，跳过云端内容写入，避免清空云端');
        }
        const ws = await this.writeCloudSubs(merged);
        await this.writeLocalSubs(merged);
        const ok = wc.success && ws.success;
        return {
            success: ok, results: { content: wc.success, submissions: ws.success },
            error: ok ? '' : [!wc.success && wc.error, !ws.success && ws.error].filter(Boolean).join('；')
        };
    },

    async syncFromCloud() {
        if (this.getMode() === 'github') {
            const cloudContent = await this.readGitHubContent();
            const cloudSubs = await this.readGitHubSubs();
            if (cloudContent === null) return { success: false, error: '无法连接 GitHub，请检查仓库和 Token' };
            const localContent = await this.readLocalContent() || {};
            const localSubs = await this.readLocalSubs() || [];
            const mergedContent = this.mergeContent(localContent, cloudContent).content;
            const mergedSubs = this.mergeSubs(localSubs, cloudSubs || []);
            const wl = await this.writeLocalContent(mergedContent);
            const wsl = await this.writeLocalSubs(mergedSubs);
            const ok = wl.success && wsl.success;
            const ts = this._nowStr();
            localStorage.setItem('lecang_cloud_lastsync', ts);
            return { success: ok, content: mergedContent, submissions: mergedSubs, error: ok ? '' : [!wl.success && wl.error, !wsl.success && wsl.error].filter(Boolean).join('；') };
        }
        if (!this.hasCloudServer()) return { success: false, error: '未配置云端地址' };
        const cloudContent = await this.readCloudContent();
        const cloudSubs = await this.readCloudSubs();
        if (cloudContent === null) return { success: false, error: '无法连接云端，请检查云端地址和管理密码' };
        const localContent = await this.readLocalContent() || {};
        const localSubs = await this.readLocalSubs() || [];
        const mergedContent = this.mergeContent(localContent, cloudContent).content;
        const mergedSubs = this.mergeSubs(localSubs, cloudSubs || []);
        const wl = await this.writeLocalContent(mergedContent);
        const wsl = await this.writeLocalSubs(mergedSubs);
        const ok = wl.success && wsl.success;
        const ts = this._nowStr();
        localStorage.setItem('lecang_cloud_lastsync', ts);
        return { success: ok, content: mergedContent, submissions: mergedSubs, error: ok ? '' : [!wl.success && wl.error, !wsl.success && wsl.error].filter(Boolean).join('；') };
    },

    async testConnection() {
        if (this.getMode() === 'github') return this.testGitHub();
        if (!this.hasCloudServer()) return { success: false, error: '未配置内网穿透服务器地址' };
        const r = await this._req(this._base(), 'GET', '/status', null, false);
        if (!r.success) return { success: false, error: r.error || '连接失败' };
        return { success: true, message: '连接成功！云端服务器工作正常' };
    },

    async testGitHub() {
        if (!this.hasGitHub()) return { success: false, error: '未配置 GitHub 仓库或 Token' };
        const d = await this.readGitHubRaw();
        if (d && d.success === false) return { success: false, error: d.error };
        return { success: true, message: 'GitHub 连接成功！仓库可读取' + (d ? '（已有数据）' : '（仓库暂无数据，首次同步将自动创建）') };
    },

    _nowStr() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    },

    // ===== 本地缓存（离线回退 / 导出）=====
    getContent() {
        try { return JSON.parse(localStorage.getItem('lecang_content') || '{}'); }
        catch (e) { return {}; }
    },
    setContent(data) { localStorage.setItem('lecang_content', JSON.stringify(data)); },
    getSubmissions() {
        try { return JSON.parse(localStorage.getItem('lecang_submissions') || '[]'); }
        catch (e) { return []; }
    },
    setSubmissions(arr) { localStorage.setItem('lecang_submissions', JSON.stringify(arr || [])); },
    addSubmissionLocal(submission) {
        const submissions = this.getSubmissions();
        submission.id = 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        submission.createdAt = new Date().toISOString();
        submissions.unshift(submission);
        localStorage.setItem('lecang_submissions', JSON.stringify(submissions));
        return submission.id;
    },
    deleteSubmissionLocal(id) {
        let submissions = this.getSubmissions();
        submissions = submissions.filter(s => s.id !== id);
        localStorage.setItem('lecang_submissions', JSON.stringify(submissions));
        return true;
    },
    clearSubmissionsLocal() {
        localStorage.removeItem('lecang_submissions');
        return true;
    },

    // ===== 导出/导入 JSON 备份 =====
    exportAllData(contentData, submissionsData) {
        const data = {
            version: '5.0',
            content: contentData || this.getContent(),
            submissions: submissionsData || this.getSubmissions(),
            exportTime: new Date().toISOString()
        };
        return JSON.stringify(data, null, 2);
    },
    importAllData(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            if (data.content && typeof data.content === 'object') {
                if (data.content) this.setContent(data.content);
                if (data.submissions) localStorage.setItem('lecang_submissions', JSON.stringify(data.submissions));
                return {
                    success: true, hasContent: !!data.content,
                    submissionCount: data.submissions ? data.submissions.length : 0,
                    content: data.content, submissions: data.submissions || []
                };
            } else {
                this.setContent(data);
                return { success: true, hasContent: true, submissionCount: 0, content: data, submissions: [] };
            }
        } catch (e) { return { success: false, error: e.message }; }
    }
};

// 初始化
CloudSync.init();
