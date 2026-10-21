'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { ConfigStore } = require('../lib/config');

function initialize(configPath = process.env.DS_CONFIG_PATH || '/data/config.json') {
  const store = new ConfigStore(configPath);
  const config = store.read();
  store.accounts(config);
  let changed = false;
  for (const [field, prefix] of [['api_key', 'sk-'], ['admin_key', 'admin-']]) {
    if (config[field] !== undefined && config[field] !== null && typeof config[field] !== 'string') {
      throw new Error('invalid_key');
    }
    if (!config[field] || !config[field].trim()) {
      config[field] = prefix + crypto.randomBytes(32).toString('hex');
      changed = true;
    }
  }
  if (changed) store.write(config);
  fs.chmodSync(store.filePath, 0o600);
  return config;
}

function showCredentials(configPath = process.env.DS_CONFIG_PATH || '/data/config.json') {
  // 显式执行该命令时才显示密钥，服务启动及 Docker 日志不输出凭证。
  if (!fs.existsSync(configPath)) throw new Error('config_not_initialized');
  const config = new ConfigStore(configPath).read();
  const apiKey = process.env.DS_API_KEY || config.api_key;
  const adminKey = process.env.DS_ADMIN_KEY || config.admin_key;
  if (typeof apiKey !== 'string' || !apiKey || typeof adminKey !== 'string' || !adminKey) {
    throw new Error('keys_not_configured');
  }
  console.log('API Key:   ' + apiKey);
  console.log('Admin Key: ' + adminKey);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--show-credentials') {
      showCredentials();
    } else if (!args.length) {
      initialize();
      require('../server');
    } else {
      console.error('用法：node docker/entrypoint.js [--show-credentials]');
      process.exitCode = 2;
    }
  } catch (error) {
    // JSON 解析异常可能带原始配置片段；这里只显示错误类别。
    console.error('容器启动失败，请检查持久化配置和数据卷权限（' +
      (error.code || error.name || 'initialization_error') + '）');
    process.exitCode = 1;
  }
}

module.exports = { initialize, showCredentials };
