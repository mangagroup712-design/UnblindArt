'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/describe') {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'サーバーに CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を設定してください。' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '画像データが大きすぎます。' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const { image } = JSON.parse(body);
        const match = typeof image === 'string' && image.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/);
        if (!match || Buffer.from(match[2], 'base64').length > 1024 * 1024) throw new Error('画像データを読み取れません。');
        const model = '@cf/meta/llama-3.2-11b-vision-instruct';
        const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
          body: JSON.stringify({
            prompt: 'この画像は32×32マスのドット絵です。何が描かれているか、見える形と色を根拠に、日本語で説明してください。最初に何に見えるかを短く述べ、続けて輪郭、色、配置などの特徴を説明してください。確信できない場合は断定せず、不明と伝えてください。見えない細部を作り足さず、回答文だけを出力してください。',
            image,
            max_tokens: 220,
            temperature: 0.1
          }),
          signal: AbortSignal.timeout(60000)
        });
        const data = await upstream.json();
        if (!upstream.ok || data.success === false) {
          const details = data.errors?.map(item => item.message).filter(Boolean).join(' / ');
          throw new Error(details || `Cloudflare Workers AI でエラーが発生しました（HTTP ${upstream.status}）。`);
        }
        const description = (data.result?.response || data.result?.description || '').trim();
        if (!description) {
          throw new Error('Cloudflare Workers AI から説明文が返りませんでした。もう一度お試しください。');
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ description }));
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message || '画像を説明できませんでした。' }));
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`サーバーを起動しました: http://localhost:${PORT}`);
  console.log('同じWi-Fiの端末からは、次のいずれかのアドレスを開いてください:');
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces || []) {
      if (info.family === 'IPv4' && !info.internal) {
        console.log(`  http://${info.address}:${PORT}`);
      }
    }
  }
  console.log('終了するには Ctrl+C を押してください。');
});
