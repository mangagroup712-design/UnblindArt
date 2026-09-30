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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'サーバーに GEMINI_API_KEY が設定されていません。' }));
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
        const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'これは32×32マスのドット絵です。何が描かれているか、画像で確認できる形と色を根拠に説明してください。最初に何に見えるかを簡潔に述べ、そのあと輪郭、色、配置などの特徴を簡潔に説明してください。小さな違いから断定しすぎず、判別が難しい場合はそのことも伝えてください。見えない細部や背景を作り足さず、回答文だけを出力してください。回答のみを出力し、マークダウン形式で記述しないようにしてください。3文程度で出力するように。' }, { inline_data: { mime_type: match[1], data: match[2] } }] }],
            generationConfig: {
                maxOutputTokens: 150,
                temperature: 0.1,
                thinkingConfig: {
                  thinkingLevel: 'low'
                }
              }
            })
        });
        const data = await upstream.json();
        if (!upstream.ok) throw new Error(data.error?.message || 'Gemini API でエラーが発生しました。');
        const candidate = data.candidates?.[0];
        const description = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
        if (!description) {
          const reason = candidate?.finishReason || data.promptFeedback?.blockReason;
          throw new Error(reason ? `Gemini が説明を返せませんでした（${reason}）。もう一度お試しください。` : 'Gemini から説明文が返りませんでした。もう一度お試しください。');
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
