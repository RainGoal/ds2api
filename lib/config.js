'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeAccounts } = require('./pool');

// 账号变更与登录共用原子写入，避免中途退出留下不完整 JSON。
class ConfigStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'config.example.json'), this.filePath);
    }
  }

  read() {
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('配置必须是 JSON 对象');
    }
    return raw;
  }

  accounts(raw = this.read()) {
    if (raw.accounts !== undefined && !Array.isArray(raw.accounts)) {
      throw new Error('accounts 必须是数组');
    }
    const token = process.env.DS_TOKEN || raw.token || '';
    const accounts = raw.accounts !== undefined ? raw.accounts : token ? [{
      id: 'default', name: '默认账号', token,
      device_id: raw.device_id || crypto.randomUUID(),
    }] : [];
    return normalizeAccounts(accounts, raw.pool_settings || {});
  }

  write(raw) {
    const temporary = this.filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  saveAccounts(accounts) {
    const raw = this.read();
    const normalized = normalizeAccounts(accounts, raw.pool_settings || {});
    raw.accounts = normalized;
    // 迁移后凭证只保存在 accounts 中，空数组也表示明确启用号池模式。
    raw.token = '';
    this.write(raw);
    return normalized;
  }
}

module.exports = { ConfigStore };
