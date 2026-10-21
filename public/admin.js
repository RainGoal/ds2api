'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { key: '', snapshot: null, tab: 'overview', editingId: null, logsOffset: 0, logsTotal: 0, logsTruncated: false, statusLoading: false, logsLoading: false, generation: 0 };
  const PAGE_SIZE = 30;
  const statuses = { available: '可用', busy: '处理中', rate_limited: '频率受限', cooldown: '冷却中', invalid: '已隔离', missing_token: '未配置凭证', disabled: '已停用' };
  const healthStatuses = { unknown: '待验证', healthy: '正常', unhealthy: '异常' };
  const healthReasons = { missing_token: '未配置 Token', token_expired: 'Token 已到期', authentication_failed: '凭证鉴权失败', account_muted: '账号已被禁言', verification_required: '需要完成账号验证', rate_limited: '上游限流，等待冷却', upstream_error: '上游请求异常，等待冷却', awaiting_retry: '冷却结束，等待请求验证' };
  const outcomes = { success: '成功', failed: '失败', cancelled: '已取消' };
  const errorKinds = { auth: '凭证失效', rate_limit: '上游限流', mute: '账号受限', captcha: '需要验证', upstream: '上游异常', queue_timeout: '排队超时', pool_unavailable: '无可用账号', cancelled: '请求取消' };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const count = (value) => new Intl.NumberFormat('zh-CN').format(number(value));
  const percent = (value) => `${(Math.max(0, Math.min(1, number(value))) * 100).toFixed(1)}%`;
  const latency = (value) => number(value) >= 1000 ? `${(number(value) / 1000).toFixed(1)}s` : `${Math.round(number(value))}ms`;
  const accounts = () => state.snapshot?.pool?.accounts || [];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function showError(target, message) {
    target.textContent = message;
    target.hidden = !message;
  }

  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !message;
  }

  function renderPersistenceWarnings() {
    const statistics = state.snapshot?.statistics || {};
    const warnings = [];
    if (state.snapshot?.pool?.persistence_error) warnings.push('账号状态保存失败，重启后可能无法恢复当前失效与冷却状态。');
    if (statistics.persistence_error) warnings.push('统计或日志写入失败，请检查数据目录权限和磁盘空间。');
    if (number(statistics.dropped_logs) > 0) warnings.push(`已有 ${count(statistics.dropped_logs)} 条日志因写入积压被丢弃。`);
    showError($('persistence-warning'), warnings.join(' '));
    const limited = state.logsTruncated || statistics.logging_warning === 'recent_logs_limited';
    showError($('logs-retention-note'), limited ? `管理台最多查询最近 ${count(statistics.recent_log_limit || 10000)} 条日志。更早记录可在数据目录的轮转日志中查看。` : '');
  }

  async function withBusy(button, task, busyText = '处理中…') {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try { return await task(); }
    finally { button.disabled = false; button.textContent = original; }
  }

  async function api(path, options = {}, key = state.key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/admin/api${path}`, {
        method: options.method || 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('服务返回了无法读取的内容，请确认管理 API 已启用。'); }
      if (!response.ok) {
        const error = new Error(data.error?.message || `请求失败（HTTP ${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error('无法连接服务，请检查 ds2api 是否正在运行。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function disconnected(message = '') {
    state.generation++;
    state.key = '';
    state.snapshot = null;
    state.logsTruncated = false;
    $('admin-key').value = '';
    $('connection-status').classList.remove('connected');
    $('connection-status').replaceChildren(element('span', 'signal-dot'), document.createTextNode('尚未连接'));
    $('disconnect-button').disabled = true;
    $('last-updated').textContent = '等待连接';
    renderPersistenceWarnings();
    if ($('account-dialog').open) closeEditor();
    showError($('auth-error'), message);
    if (!$('auth-dialog').open) $('auth-dialog').showModal();
    $('admin-key').focus();
  }

  function handleError(error) {
    if (error.status === 401) { disconnected('管理密钥无效或已更新，请重新连接。'); return; }
    notice(error.message || '操作失败，请重试。', true);
  }

  async function refreshStatus(silent = false) {
    if (!state.key || state.statusLoading) return;
    state.statusLoading = true;
    const generation = state.generation;
    try {
      const snapshot = await api('/status');
      if (generation !== state.generation) return;
      state.snapshot = snapshot;
      renderStatus();
      if (!silent) notice('号池状态已更新。');
    } catch (error) { if (generation === state.generation) handleError(error); }
    finally { state.statusLoading = false; }
  }

  function statusBadge(account) {
    const status = Object.hasOwn(statuses, account.status) ? account.status : 'invalid';
    const badge = element('span', `status-badge badge-${status}`);
    badge.append(element('i', `legend-dot status-${status}`), document.createTextNode(statuses[status]));
    return badge;
  }

  function identityCell(account) {
    const cell = element('td');
    const identity = element('div', 'account-identity');
    const name = String(account.name || account.id);
    const avatar = element('span', 'account-avatar', Array.from(name).slice(0, 2).join('').toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const details = element('div');
    const nameNode = element('div', 'account-name', name);
    nameNode.title = name;
    const idNode = element('div', 'account-id', account.id);
    idNode.title = String(account.id);
    details.append(nameNode, idNode);
    identity.append(avatar, details);
    cell.append(identity);
    return cell;
  }

  function stateCell(account) {
    const cell = element('td');
    cell.append(statusBadge(account));
    if (account.status === 'cooldown' && account.cooldown_until) {
      const remaining = Math.max(0, Math.ceil((new Date(account.cooldown_until).getTime() - Date.now()) / 1000));
      cell.append(element('div', 'cell-subtext', `约 ${remaining} 秒后重试`));
    }
    if (typeof account.schedulable === 'boolean') {
      cell.append(element('div', 'cell-subtext', account.schedulable ? '当前可调度' : '当前暂停调度'));
    } else if (account.status === 'invalid') {
      const reason = account.invalid_reason;
      const reasonText = reason && (healthReasons[reason] || errorKinds[reason]);
      cell.append(element('div', 'cell-subtext', reasonText || '请更新凭证或处理账号验证'));
    }
    if (account.token_expires_at) cell.title = `Token 到期：${formatTime(account.token_expires_at)}`;
    return cell;
  }

  function healthCell(account) {
    const health = Object.hasOwn(healthStatuses, account.health_status) ? account.health_status : 'unknown';
    const cell = element('td', 'health-cell');
    const badge = element('span', `status-badge badge-health-${health}`);
    badge.append(element('i', `legend-dot health-${health}`), document.createTextNode(healthStatuses[health]));
    const reason = account.health_reason || (health === 'unhealthy' ? account.invalid_reason : null);
    const fallback = { unknown: '等待请求验证', healthy: '最近请求成功', unhealthy: '最近请求异常' };
    const reasonText = reason && Object.hasOwn(healthReasons, reason) ? healthReasons[reason] : fallback[health];
    const checked = account.last_checked_at ? `最近验证：${formatTime(account.last_checked_at)}` : '尚无请求验证结果';
    cell.title = checked;
    badge.title = checked;
    cell.append(badge, element('div', 'cell-subtext health-reason', reasonText));
    return cell;
  }

  function budgetCell(account) {
    const cell = element('td');
    const qps = element('div', 'rate-budget');
    qps.append(document.createTextNode(`${number(account.qps_used)}/${number(account.qps)}`), element('span', 'muted', ' QPS'));
    const rpm = element('div', 'rate-budget');
    rpm.append(document.createTextNode(`${number(account.rpm_used)}/${number(account.rpm)}`), element('span', 'muted', ' RPM'));
    cell.append(qps, rpm);
    return cell;
  }

  function accountStats(account) {
    const persisted = state.snapshot?.statistics?.accounts?.[account.id];
    return persisted || account.stats || {};
  }

  function successCell(account) {
    const stats = accountStats(account);
    const total = number(stats.total ?? stats.attempts);
    const cell = element('td');
    const line = element('div', 'success-cell');
    const track = element('span', 'success-track');
    const fill = element('span', 'success-fill');
    fill.style.setProperty('--progress', percent(stats.success_rate));
    track.append(fill);
    line.append(track, document.createTextNode(total ? percent(stats.success_rate) : '—'));
    cell.append(line, element('div', 'cell-subtext', `${count(stats.success)} 成功 / ${count(total)} 次尝试`));
    return cell;
  }

  function emptyRow(body, columns, message) {
    const row = element('tr');
    const cell = element('td', 'empty-cell', message);
    cell.colSpan = columns;
    row.append(cell);
    body.replaceChildren(row);
  }

  function renderAccounts(bodyId, withActions) {
    const body = $(bodyId);
    body.replaceChildren();
    const list = accounts();
    if (!list.length) { emptyRow(body, withActions ? 7 : 6, '号池中还没有账号。在“账号管理”中添加第一个账号。'); return; }
    for (const account of list) {
      const row = element('tr');
      row.append(identityCell(account), healthCell(account), stateCell(account), budgetCell(account), element('td', 'mono', `${number(account.in_flight)} / ${number(account.max_concurrent)}`), successCell(account));
      if (withActions) {
        const cell = element('td');
        const actions = element('div', 'account-actions');
        const edit = element('button', 'row-action', '编辑');
        edit.type = 'button';
        edit.addEventListener('click', () => openEditor(account));
        const toggle = element('button', 'row-action', account.enabled ? '停用' : '启用');
        toggle.type = 'button';
        toggle.addEventListener('click', () => toggleAccount(account, toggle));
        const remove = element('button', 'row-action danger', '删除');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteAccount(account, remove));
        actions.append(edit, toggle, remove);
        cell.append(actions);
        row.append(cell);
      }
      body.append(row);
    }
  }

  function renderDistribution() {
    const list = accounts();
    const distribution = [
      { label: '可用', key: 'available', count: list.filter((a) => a.status === 'available').length },
      { label: '处理中', key: 'busy', count: list.filter((a) => a.status === 'busy').length },
      { label: '冷却中', key: 'cooldown', count: list.filter((a) => a.status === 'cooldown').length },
      { label: '频率受限', key: 'rate_limited', count: list.filter((a) => a.status === 'rate_limited').length },
      { label: '需处理', key: 'invalid', count: list.filter((a) => a.status === 'invalid' || a.status === 'missing_token').length },
      { label: '已停用', key: 'disabled', count: list.filter((a) => a.status === 'disabled').length },
    ];
    $('pool-distribution').replaceChildren();
    $('pool-strip').replaceChildren();
    for (const item of distribution) {
      const line = element('div', 'distribution-item');
      line.append(element('i', `legend-dot status-${item.key}`), document.createTextNode(item.label), element('strong', '', item.count));
      $('pool-distribution').append(line);
      if (item.count) {
        const segment = element('span', `pool-strip-block status-${item.key}`);
        segment.style.setProperty('--weight', String(item.count));
        segment.title = `${item.label}：${item.count}`;
        $('pool-strip').append(segment);
      }
    }
    if (!list.length) $('pool-strip').append(element('span', 'pool-strip-empty'));
  }

  function renderAccountFilter() {
    const selected = $('filter-account').value;
    $('filter-account').replaceChildren(element('option', '', '全部账号'));
    $('filter-account').options[0].value = '';
    for (const account of accounts()) {
      const option = element('option', '', account.name || account.id);
      option.value = account.id;
      $('filter-account').append(option);
    }
    if (selected && !accounts().some((a) => a.id === selected)) {
      const option = element('option', '', `${selected}（历史账号）`);
      option.value = selected;
      $('filter-account').append(option);
    }
    $('filter-account').value = selected;
  }

  function renderStatus() {
    const summary = state.snapshot.pool?.summary || {};
    const requests = state.snapshot.statistics?.requests || {};
    $('metric-available').replaceChildren(document.createTextNode(count(summary.available)), element('span', 'metric-unit', `/ ${count(summary.total)}`));
    $('metric-requests').textContent = count(requests.total);
    $('metric-success').textContent = number(requests.total) ? percent(requests.success_rate) : '—';
    $('metric-latency').textContent = number(requests.total) ? latency(requests.average_duration_ms) : '—';
    $('metric-pool-description').textContent = `${count(summary.busy)} 个处理中 · ${count(summary.cooling_down)} 个冷却中`;
    $('metric-success-description').textContent = `${count(requests.success)} 成功 · ${count(requests.failed)} 失败 · ${count(requests.cancelled)} 取消`;
    $('queue-count').textContent = count(summary.pending);
    $('accounts-count').textContent = `共 ${count(summary.total)} 个账号`;
    $('sidebar-account-count').textContent = `${String(number(summary.total)).padStart(2, '0')} ACCOUNTS`;
    $('last-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    renderDistribution();
    renderAccounts('overview-accounts-body', false);
    renderAccounts('accounts-body', true);
    renderAccountFilter();
    renderPersistenceWarnings();
  }

  function selectTab(tab) {
    if (!['overview', 'accounts', 'logs'].includes(tab)) return;
    state.tab = tab;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const name of ['overview', 'accounts', 'logs']) $(`page-${name}`).hidden = name !== tab;
    if (tab === 'logs' && state.key) loadLogs();
    else if (state.key) refreshStatus(true);
  }

  function inputValue(form, name, value) { form.elements.namedItem(name).value = value ?? ''; }

  function localDateValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function openEditor(account = null) {
    if (!state.key) return;
    const form = $('account-form');
    form.reset();
    state.editingId = account?.id ?? null;
    $('account-dialog-title').textContent = account ? '编辑账号' : '添加账号';
    const idField = form.elements.namedItem('id');
    idField.readOnly = !!account;
    form.elements.namedItem('token').required = !account;
    $('token-help').textContent = account ? '留空保留当前凭证；填写新 Token 后恢复凭证失效的账号。' : '凭证仅用于上游请求，不会在列表中回显。';
    if (account) {
      for (const name of ['id', 'name', 'qps', 'rpm', 'max_concurrent']) inputValue(form, name, account[name]);
      inputValue(form, 'cooldown_seconds', account.cooldown_seconds ?? 60);
      inputValue(form, 'max_cooldown_seconds', account.max_cooldown_seconds ?? 900);
      inputValue(form, 'token_expires_at', localDateValue(account.token_expires_at));
      form.elements.namedItem('enabled').checked = !!account.enabled;
    }
    showError($('account-error'), '');
    $('account-dialog').showModal();
    form.elements.namedItem('name').focus();
  }

  function closeEditor() {
    $('account-form').reset();
    state.editingId = null;
    $('account-dialog').close();
  }

  async function saveAccount(event) {
    event.preventDefault();
    const form = $('account-form');
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const body = { name: String(values.get('name')).trim(), enabled: values.get('enabled') === 'on' };
    for (const name of ['qps', 'rpm', 'max_concurrent', 'cooldown_seconds', 'max_cooldown_seconds']) body[name] = Number(values.get(name));
    if (body.max_cooldown_seconds < body.cooldown_seconds) { showError($('account-error'), '最长冷却时间不能小于基础冷却时间。'); return; }
    const token = String(values.get('token') || '').trim();
    if (token) body.token = token;
    if (!state.editingId && values.get('id')) body.id = String(values.get('id')).trim();
    const expiry = String(values.get('token_expires_at') || '');
    if (expiry) body.token_expires_at = new Date(expiry).toISOString();
    else body.token_expires_at = null;
    showError($('account-error'), '');
    const generation = state.generation;
    const editingId = state.editingId;
    await withBusy($('save-account-button'), async () => {
      try {
        await api(editingId ? `/accounts/${encodeURIComponent(editingId)}` : '/accounts', { method: editingId ? 'PATCH' : 'POST', body });
        if (generation !== state.generation) return;
        closeEditor();
        await refreshStatus(true);
        notice(editingId ? '账号设置已保存，立即生效。' : '账号已添加到号池。');
      } catch (error) {
        if (generation !== state.generation) return;
        if (error.status === 401) handleError(error);
        else showError($('account-error'), error.message);
      }
    }, '正在保存…');
  }

  async function toggleAccount(account, button) {
    const generation = state.generation;
    await withBusy(button, async () => {
      try {
        await api(`/accounts/${encodeURIComponent(account.id)}`, { method: 'PATCH', body: { enabled: !account.enabled } });
        if (generation !== state.generation) return;
        await refreshStatus(true);
        notice(account.enabled ? '账号已停用；已开始的请求继续完成。' : '账号已启用。');
      } catch (error) { if (generation === state.generation) handleError(error); }
    });
  }

  async function deleteAccount(account, button) {
    if (!window.confirm(`确定删除账号“${account.name || account.id}”吗？历史请求日志和统计会保留。`)) return;
    const generation = state.generation;
    await withBusy(button, async () => {
      try {
        await api(`/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
        if (generation !== state.generation) return;
        await refreshStatus(true);
        notice('账号已从号池移除。');
      } catch (error) { if (generation === state.generation) handleError(error); }
    });
  }

  function formatTime(value, seconds = true) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });
  }

  function renderLogs(result) {
    const body = $('logs-body');
    body.replaceChildren();
    const list = Array.isArray(result.data) ? result.data : [];
    if (!list.length) emptyRow(body, 7, '没有符合条件的请求日志。');
    for (const log of list) {
      const row = element('tr');
      const time = element('td');
      const requestId = element('div', 'log-request-id', log.request_id || '—');
      requestId.title = String(log.request_id || '');
      time.append(element('div', 'log-date', formatTime(log.started_at)), requestId);
      const account = accounts().find((entry) => entry.id === log.account_id);
      const accountCell = element('td', '', account?.name || log.account_id || '未分配');
      if (account?.name) accountCell.append(element('div', 'cell-subtext mono', log.account_id));
      const outcome = Object.hasOwn(outcomes, log.outcome) ? log.outcome : 'failed';
      const outcomeCell = element('td', `outcome-${outcome}`, outcomes[outcome]);
      const httpStatus = log.http_status ?? log.status;
      if (httpStatus) outcomeCell.append(element('div', 'cell-subtext mono', `HTTP ${httpStatus}`));
      const mode = element('td', 'mono', log.model || '—');
      mode.append(element('div', 'cell-subtext', log.stream ? '流式' : '非流式'));
      const kind = log.error_kind;
      row.append(time, accountCell, outcomeCell, element('td', 'mono', latency(log.duration_ms)), element('td', 'mono', number(log.attempts)), mode, element('td', 'cell-subtext', kind ? (Object.hasOwn(errorKinds, kind) ? errorKinds[kind] : String(kind)) : '—'));
      body.append(row);
    }
    state.logsTotal = number(result.total);
    state.logsTruncated = result.truncated === true;
    renderPersistenceWarnings();
    $('log-total').textContent = `${count(state.logsTotal)} 条记录`;
    const pageCount = Math.max(1, Math.ceil(state.logsTotal / PAGE_SIZE));
    $('log-page-label').textContent = `第 ${Math.floor(state.logsOffset / PAGE_SIZE) + 1} / ${pageCount} 页`;
    $('logs-previous').disabled = state.logsOffset === 0;
    $('logs-next').disabled = state.logsOffset + PAGE_SIZE >= state.logsTotal;
  }

  async function loadLogs() {
    if (!state.key || state.logsLoading) return;
    state.logsLoading = true;
    const generation = state.generation;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.logsOffset) });
    if ($('filter-account').value) params.set('account_id', $('filter-account').value);
    if ($('filter-outcome').value) params.set('outcome', $('filter-outcome').value);
    try {
      const result = await api(`/logs?${params}`);
      if (generation !== state.generation) return;
      renderLogs(result);
    } catch (error) { if (generation === state.generation) handleError(error); }
    finally { state.logsLoading = false; }
  }

  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!$('auth-form').reportValidity()) return;
    const key = $('admin-key').value.trim();
    $('admin-key').value = '';
    if (!key) { showError($('auth-error'), '请输入管理密钥。'); return; }
    showError($('auth-error'), '');
    await withBusy(event.submitter || $('auth-form').querySelector('button'), async () => {
      try {
        const snapshot = await api('/status', {}, key);
        state.generation++;
        state.key = key;
        state.snapshot = snapshot;
        state.logsOffset = 0;
        $('auth-dialog').close();
        $('connection-status').classList.add('connected');
        $('connection-status').replaceChildren(element('span', 'signal-dot'), document.createTextNode('号池已连接'));
        $('disconnect-button').disabled = false;
        renderStatus();
        notice('');
        if (state.tab === 'logs') loadLogs();
      } catch (error) { showError($('auth-error'), error.message); $('admin-key').focus(); }
    }, '正在连接…');
  });
  $('auth-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('disconnect-button').addEventListener('click', () => disconnected());
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => selectTab(button.dataset.tab));
  for (const button of document.querySelectorAll('[data-go-tab]')) button.addEventListener('click', () => selectTab(button.dataset.goTab));
  for (const button of document.querySelectorAll('.refresh-status')) button.addEventListener('click', () => refreshStatus());
  $('add-account-button').addEventListener('click', () => openEditor());
  $('close-account-dialog').addEventListener('click', closeEditor);
  $('cancel-account-dialog').addEventListener('click', closeEditor);
  $('account-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
  $('account-form').addEventListener('submit', saveAccount);
  $('refresh-logs').addEventListener('click', loadLogs);
  $('log-filter-form').addEventListener('submit', (event) => { event.preventDefault(); if (state.logsLoading) return; state.logsOffset = 0; loadLogs(); });
  $('logs-previous').addEventListener('click', () => { if (state.logsLoading) return; state.logsOffset = Math.max(0, state.logsOffset - PAGE_SIZE); loadLogs(); });
  $('logs-next').addEventListener('click', () => { if (state.logsLoading) return; state.logsOffset += PAGE_SIZE; loadLogs(); });
  $('api-endpoint').value = `${window.location.origin}/v1`;
  $('copy-endpoint').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('api-endpoint').value); notice('API Base URL 已复制。'); }
    catch { $('api-endpoint').select(); notice('请复制已选中的 API Base URL。'); }
  });
  setInterval(() => { if (state.key && document.visibilityState === 'visible') refreshStatus(true); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.key) refreshStatus(true); });
  window.addEventListener('pagehide', () => { state.key = ''; $('admin-key').value = ''; $('account-form').reset(); });
  disconnected();
})();
