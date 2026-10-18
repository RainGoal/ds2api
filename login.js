#!/usr/bin/env node
'use strict';
// 登录 DeepSeek 网页版并把 token 写入 config.json
//
// 用法：
//   node login.js <邮箱> <密码>              邮箱密码登录
//   node login.js --phone <手机号> <密码>    手机号登录（默认中国区 +86）
//   node login.js --token <token>            手动粘贴浏览器里的 token
//   node login.js --show                     查看当前配置状态
//
// 手动获取 token：浏览器打开 chat.deepseek.com 并登录 → F12 → Application →
// Local Storage → userToken 的 value 字段（JSON 里的 "value" 值即是 token）。

const fs = require('fs');
const path = require('path');
const { DeepSeekClient, UpstreamError } = require('./lib/dsweb');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(__dirname, 'config.example.json'))) {
      fs.copyFileSync(path.join(__dirname, 'config.example.json'), CONFIG_PATH);
      console.log('[提示] 已从 config.example.json 生成 config.json');
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error(`[错误] 无法读取 config.json: ${e.message}`);
    process.exit(1);
  }
}

function saveToken(token) {
  const cfg = loadConfig();
  cfg.token = token;
  if (!cfg.device_id) cfg.device_id = require('crypto').randomUUID();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log(`[OK] token 已写入 config.json（长度 ${token.length}）`);
}

function clientOpts(cfg) {
  return {
    baseUrl: cfg.base_url,
    userAgent: cfg.user_agent || undefined,
    acceptLanguage: cfg.accept_language || undefined,
    extraHeaders: cfg.extra_headers || {},
    riskHeaders: cfg.risk_headers ?? true,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`用法：
  node login.js <邮箱> <密码>              邮箱密码登录
  node login.js --phone <手机号> <密码>    手机号登录（默认 +86）
  node login.js --token <token>            手动粘贴 token
  node login.js --show                     查看当前状态`);
    return;
  }

  if (args.includes('--show')) {
    const cfg = loadConfig();
    console.log(`base_url: ${cfg.base_url || 'https://chat.deepseek.com'}`);
    console.log(`token:    ${cfg.token ? `已配置（长度 ${cfg.token.length}，前 8 位 ${cfg.token.slice(0, 8)}…）` : '未配置'}`);
    console.log(`port:     ${cfg.port || 3000}`);
    return;
  }

  const cfg = loadConfig();

  if (args.includes('--token')) {
    const token = args[args.indexOf('--token') + 1];
    if (!token) {
      console.error('[错误] --token 后需要跟 token 字符串');
      process.exit(1);
    }
    saveToken(token);
    return;
  }

  let loginArgs;
  if (args.includes('--phone')) {
    const mobile = args[args.indexOf('--phone') + 1];
    const password = args[args.indexOf('--phone') + 2];
    if (!mobile || !password) {
      console.error('[错误] 用法: node login.js --phone <手机号> <密码>');
      process.exit(1);
    }
    loginArgs = { mobile, password, ...clientOpts(cfg) };
  } else {
    const [email, password] = args;
    if (!email || !password) {
      console.error('[错误] 用法: node login.js <邮箱> <密码>');
      process.exit(1);
    }
    loginArgs = { email, password, ...clientOpts(cfg) };
  }

  console.log('正在登录 DeepSeek 网页版…');
  try {
    const token = await DeepSeekClient.login(loginArgs);
    saveToken(token);
    console.log('登录成功 ✔  现在可以运行 start.bat 启动代理');
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.error(`[登录失败] ${e.message}（${e.kind}）`);
      if (e.kind === 'captcha') {
        console.error('提示：需要过验证码时，请改用浏览器登录后手动提取 token（node login.js --token <token>）');
      }
    } else {
      console.error(`[登录失败] ${e.message}`);
    }
    process.exit(1);
  }
}

main();
