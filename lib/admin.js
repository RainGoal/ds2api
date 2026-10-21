'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeAccounts } = require('./pool');

const FIELDS = new Set([
  'id', 'name', 'token', 'enabled', 'qps', 'rpm', 'max_concurrent',
  'cooldown_seconds', 'max_cooldown_seconds', 'token_expires_at', 'device_id', 'extra_headers',
]);
const STATIC = {
  '/admin': ['admin.html', 'text/html'],
  '/admin/': ['admin.html', 'text/html'],
  '/admin/admin.js': ['admin.js', 'application/javascript'],
  '/admin/admin.css': ['admin.css', 'text/css'],
};

function serveAdminPage(req, res, pathname) {
  const asset = Object.hasOwn(STATIC, pathname) && STATIC[pathname];
  if (!asset || !['GET', 'HEAD'].includes(req.method)) return false;
  const body = fs.readFileSync(path.join(__dirname, '..', 'public', asset[0]));
  res.writeHead(200, {
    'content-type': asset[1] + '; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function createAdminHandler({ store, pool, telemetry, readBody, sendJson, HttpError }) {
  const accounts = () => pool.snapshot().accounts;
  function publish(next) {
    const normalized = normalizeAccounts(next, store.read().pool_settings || {});
    store.saveAccounts(normalized);
    pool.setAccounts(normalized);
  }
  function accountBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '账号配置必须是 JSON 对象');
    for (const key of Object.keys(body)) {
      if (!FIELDS.has(key)) throw new HttpError(400, '不支持的账号字段：' + key);
    }
    return body;
  }
  return async function handleAdmin(req, res, url) {
    res.setHeader('cache-control', 'no-store');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/admin/api/status') {
      return sendJson(res, 200, { pool: pool.snapshot(), statistics: telemetry.stats() });
    }
    if (req.method === 'GET' && route === '/admin/api/stats') return sendJson(res, 200, telemetry.stats());
    if (req.method === 'GET' && route === '/admin/api/logs') {
      const outcome = url.searchParams.get('outcome') || undefined;
      if (outcome && !['success', 'failed', 'cancelled'].includes(outcome)) throw new HttpError(400, '无效的 outcome');
      return sendJson(res, 200, telemetry.getLogs({
        limit: url.searchParams.get('limit') || 50, offset: url.searchParams.get('offset') || 0,
        account_id: url.searchParams.get('account_id') || undefined, outcome,
      }));
    }
    if (req.method === 'GET' && route === '/admin/api/accounts') return sendJson(res, 200, { data: accounts() });
    if (req.method === 'POST' && route === '/admin/api/accounts') {
      const body = accountBody(await readBody(req, 1024 * 1024));
      const next = { ...body, id: body.id === undefined ? crypto.randomUUID() : body.id };
      const existing = store.accounts();
      if (existing.some((account) => account.id === next.id)) throw new HttpError(409, '账号 id 已存在');
      publish([...existing, next]);
      return sendJson(res, 201, { account: accounts().find((account) => account.id === next.id) });
    }
    const match = /^\/admin\/api\/accounts\/([^/]+)$/.exec(route);
    if (match && ['PATCH', 'DELETE'].includes(req.method)) {
      let id;
      try { id = decodeURIComponent(match[1]); }
      catch { throw new HttpError(400, '账号 id 编码无效'); }
      const next = store.accounts();
      const index = next.findIndex((account) => account.id === id);
      if (index < 0) throw new HttpError(404, '账号不存在');
      if (req.method === 'DELETE') {
        next.splice(index, 1);
        publish(next);
        return sendJson(res, 200, { ok: true });
      }
      const body = accountBody(await readBody(req, 1024 * 1024));
      if (body.id !== undefined && body.id !== id) throw new HttpError(400, '账号 id 不可修改');
      if (body.token !== undefined && body.token !== next[index].token && !Object.hasOwn(body, 'token_expires_at')) {
        body.token_expires_at = null;
      }
      next[index] = { ...next[index], ...body, id };
      publish(next);
      return sendJson(res, 200, { account: accounts().find((account) => account.id === id) });
    }
    throw new HttpError(404, '未知管理接口');
  };
}

module.exports = { serveAdminPage, createAdminHandler };
