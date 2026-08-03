#!/usr/bin/env node
'use strict';

// 网络导出接收端：在“不受绿盾保护的机器”上运行（另一台电脑 / 服务器 / 云主机）。
// 接收 ldDecrypt 推送过来的明文字节并直接落盘。零第三方依赖，仅用 Node 内置模块。
//
// 用法：
//   node export-receiver.js                              # 默认监听 :4000 -> 本程序所在目录/received
//   PORT=8080 DIR=D:/recv TOKEN=abc node export-receiver.js
//   node export-receiver.js --port 8080 --dir D:/recv --token abc   # 也支持命令行参数
//
// 然后在受绿盾保护的机器上，打开 ldDecrypt 网页 “④ 网络导出”，
// 填写本机地址：http://<本机IP>:4000  （建议设置 TOKEN 并一并填写）。

const http = require('http');
const fs = require('fs');
const path = require('path');

// 解析命令行参数：--port / --dir / --token（优先级高于环境变量）
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = argv[++i];
    else if (a === '--dir' || a === '-d') o.dir = argv[++i];
    else if (a === '--token' || a === '-t') o.token = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));

const PORT = parseInt(args.port || process.env.PORT || '4000', 10);
// 默认保存目录：优先 --dir / DIR 环境变量；否则为“本程序所在目录/received”
// （打包成 .exe 后 __dirname 不可靠，故用 process.execPath 所在目录）
const DIR = args.dir || process.env.DIR
  ? path.resolve(args.dir || process.env.DIR)
  : path.join(path.dirname(process.execPath), 'received');
const TOKEN = args.token !== undefined ? args.token : (process.env.TOKEN || '');

fs.mkdirSync(DIR, { recursive: true });

// 解码相对路径并防目录穿越：只保留相对片段，剔除 . / .. 与绝对前缀
function sanitizeRel(rel) {
  let s;
  try { s = decodeURIComponent(rel || 'file.bin'); }
  catch (e) { s = 'file.bin'; }
  s = s.replace(/\\/g, '/');
  const parts = s.split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.join(path.sep) || 'file.bin';
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (req.method !== 'POST' || pathname !== '/upload') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (TOKEN && auth !== 'Bearer ' + TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
    return;
  }

  const relpath = req.headers['x-relpath'] || req.headers['x-filename'] || 'file.bin';
  const safe = sanitizeRel(relpath);
  const outPath = path.join(DIR, safe);
  const root = path.resolve(DIR);
  if (!path.resolve(outPath).startsWith(root)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '非法路径' }));
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ws = fs.createWriteStream(outPath);
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.pipe(ws);
  ws.on('finish', () => {
    console.log('[recv] ' + safe + ' (' + bytes + ' bytes)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: safe, bytes }));
  });
  ws.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n[启动失败] 端口 ' + PORT + ' 已被占用。请换一个端口（--port 或 PORT 环境变量）。');
  } else {
    console.error('\n[启动失败] ' + err.message);
  }
  waitAndExit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('ldDecrypt 网络导出接收端已启动');
  console.log('  监听端口 : ' + PORT);
  console.log('  保存目录 : ' + DIR);
  console.log('  令牌保护 : ' + (TOKEN ? '已启用' : '未启用（建议设置 TOKEN）'));
  console.log('  接收地址 : http://<本机IP>:' + PORT + '/upload');
  console.log('');
  console.log('按 Ctrl+C 停止。');
});

// 崩溃时打印错误并等待（双击运行时避免窗口一闪而过）
process.on('uncaughtException', (err) => {
  console.error('\n[致命错误] ' + (err && err.message ? err.message : err));
  waitAndExit(1);
});

function waitAndExit(code) {
  if (process.stdin && process.stdin.isTTY) {
    console.log('按 Enter 键退出...');
    try {
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(code));
      return;
    } catch (e) { /* ignore */ }
  }
  process.exit(code);
}
