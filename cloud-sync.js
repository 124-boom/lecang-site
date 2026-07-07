/**
 * CloudSync - 安全云端同步模块（Worker 代理模式）
 *
 * 安全设计：网页里【绝不】存放任何 GitHub 令牌。
 * 所有读写都通过 Cloudflare Worker 代理完成，令牌只在 Worker 服务端。
 * 网页只持有一个"代理地址"和一个"管理密码"（用于保护后台写操作）。
 *
 * 接口（由 Worker 提供）：
 *   GET  /content            读取网站内容（公开）
 *   POST /content            写入网站内容（需管理密码）
 *   GET  /submissions        读取客户提交（需管理密码）
 *   POST /submit             新增一条客户提交（公开，访客用）
 *   POST /submissions-replace 整体覆盖提交列表（需管理密码）
 *   DELETE /submissions/:id  删除一条提交（需管理密码）
 *   POST /clear-submissions  清空提交（需管理密码）
 *   GET  /status             健康检查（公开）
 */
const CloudSync = {
    // 代理地址（部署 Worker 后填入；也可在后台"数据同步"面板里改）
    _defaultWorker: 'https://lecang-sync.workers.dev',

    config: { workerUrl: '', adminKey: '' },

    init() {
        try {
            const saved = localStorage.getItem('lecang_sync_config');
            if (saved) {
                this.config = JSON.parse(saved);
            } else {
                this.config = { workerUrl: this._defaultWorker, adminKey: '' };
            }
        } catch (e) {
            this.config = { workerUrl: this._defaultWorker, adminKey: '' };
        }
    },

    setConfig(workerUrl, adminKey) {
        this.config = {
            workerUrl: (workerUrl || this._defaultWorker).replace(/\/+$/, ''),
            adminKey: adminKey || ''
        };
        localStorage.setItem('lecang_sync_config', JSON.stringify(this.config));
    },

    getConfig() {
        return { ...this.config };
    },

    isConfigured() {
        return !!(this.config.workerUrl && this.config.workerUrl.indexOf('http') === 0);
    },

    _headers(admin) {
        const h = { 'Content-Type': 'application/json' };
        if (admin && this.config.adminKey) h['x-admin-key'] = this.config.adminKey;
        return h;
    },

    async _api(method, path, body, admin) {
        if (!this.isConfigured()) return { success: false, error: '未配置云端代理地址' };
        try {
            const resp = await fetch(this.config.workerUrl + path, {
                method,
                headers: this._headers(admin),
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000)
            });
            if (resp.status === 401 || resp.status === 403) {
                return { success: false, error: '管理密码错误或无权限' };
            }
            if (!resp.ok) {
                let detail = '';
                try { detail = (await resp.json()).error || ''; } catch (e) {}
                return { success: false, error: '云端返回 ' + resp.status + (detail ? '：' + detail : '') };
            }
            const data = await resp.json().catch(() => ({}));
            return { success: true, data };
        } catch (e) {
            return { success: false, error: '网络错误：' + e.message };
        }
    },

    // ===== 云端内容读写 =====
    async readContent() {
        const r = await this._api('GET', '/content', null, false);
        if (!r.success) return null;
        if (r.data && r.data.content) return r.data.content;
        return r.data || null;
    },

    async readSubmissions() {
        const r = await this._api('GET', '/submissions', null, true);
        if (!r.success) return null;
        if (Array.isArray(r.data)) return r.data;
        if (r.data && Array.isArray(r.data.submissions)) return r.data.submissions;
        return [];
    },

    async addSubmission(submission) {
        const r = await this._api('POST', '/submit', submission, false);
        return r.success ? { success: true } : { success: false, error: r.error };
    },

    async writeContent(contentData) {
        const r = await this._api('POST', '/content', contentData, true);
        return r.success ? { success: true } : { success: false, error: r.error };
    },

    async deleteSubmission(id) {
        const r = await this._api('DELETE', '/submissions/' + encodeURIComponent(id), null, true);
        return r.success ? { success: true } : { success: false, error: r.error };
    },

    async clearSubmissions() {
        const r = await this._api('POST', '/clear-submissions', null, true);
        return r.success ? { success: true } : { success: false, error: r.error };
    },

    // ===== 本地存储（缓存和回退，离线也能看） =====
    getContent() {
        try { return JSON.parse(localStorage.getItem('lecang_content') || '{}'); }
        catch (e) { return {}; }
    },
    setContent(data) {
        localStorage.setItem('lecang_content', JSON.stringify(data));
    },
    getSubmissions() {
        try { return JSON.parse(localStorage.getItem('lecang_submissions') || '[]'); }
        catch (e) { return []; }
    },
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
            version: '3.0',
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
                    success: true,
                    hasContent: !!data.content,
                    submissionCount: data.submissions ? data.submissions.length : 0,
                    content: data.content,
                    submissions: data.submissions || []
                };
            } else {
                this.setContent(data);
                return { success: true, hasContent: true, submissionCount: 0, content: data, submissions: [] };
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    // ===== 一键同步：本地 → 云端 =====
    async syncToCloud(contentData, submissionsData) {
        const results = { content: false, submissions: false };
        const errors = [];
        if (contentData) {
            const r = await this.writeContent(contentData);
            results.content = r.success;
            if (!r.success && r.error) errors.push('内容: ' + r.error);
        }
        if (submissionsData) {
            const r = await this._api('POST', '/submissions-replace', submissionsData, true);
            results.submissions = r.success;
            if (!r.success && r.error) errors.push('客户: ' + r.error);
        }
        const anySuccess = results.content || results.submissions;
        if (anySuccess) {
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            localStorage.setItem('lecang_cloud_lastsync',
                now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
        }
        return {
            success: anySuccess,
            results: results,
            error: errors.length > 0 ? errors.join('；') : (anySuccess ? '' : '上传失败')
        };
    },

    // ===== 一键同步：云端 → 本地 =====
    async syncFromCloud() {
        const cloudContent = await this.readContent();
        const cloudSubmissions = await this.readSubmissions();
        if (cloudContent === null && cloudSubmissions === null) {
            return { success: false, error: '无法从云端读取，请检查代理地址和管理密码' };
        }
        if (cloudContent) this.setContent(cloudContent);
        if (cloudSubmissions) localStorage.setItem('lecang_submissions', JSON.stringify(cloudSubmissions));
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        localStorage.setItem('lecang_cloud_lastsync',
            now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
        return { success: true, content: cloudContent, submissions: cloudSubmissions || [] };
    },

    // ===== 测试云端连接 =====
    async testConnection() {
        if (!this.isConfigured()) return { success: false, error: '未配置云端代理地址' };
        const r = await this._api('GET', '/status', null, false);
        if (!r.success) return { success: false, error: r.error || '连接失败' };
        return { success: true, message: '连接成功！云端代理工作正常' };
    }
};

// 初始化
CloudSync.init();
