const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  if (!env.AI) {
    return Response.json(
      { error: 'Cloudflare Pages の Workers AI binding（AI）が設定されていません。' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
      return Response.json({ error: '画像データが大きすぎます。' }, { status: 413 });
    }

    const { image } = JSON.parse(body);
    const match = typeof image === 'string'
      ? image.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/)
      : null;
    if (!match) {
      return Response.json({ error: '画像データを読み取れません。' }, { status: 400 });
    }

    const binary = atob(match[2]);
    if (binary.length > MAX_IMAGE_BYTES) {
      return Response.json({ error: '画像データが大きすぎます。' }, { status: 413 });
    }

    const result = await env.AI.run(MODEL, {
      prompt: 'この画像は32×32マスのドット絵です。何が描かれているか、見える形と色を根拠に、日本語で説明してください。最初に何に見えるかを短く述べ、続けて輪郭、色、配置などの特徴を説明してください。確信できない場合は断定せず、不明と伝えてください。見えない細部を作り足さず、回答文だけを出力してください。',
      image,
      max_tokens: 220,
      temperature: 0.1
    });

    const description = (result?.response || result?.description || '').trim();
    if (!description) {
      return Response.json(
        { error: 'Cloudflare Workers AI から説明文が返りませんでした。もう一度お試しください。' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return Response.json({ description }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { error: error.message || 'Cloudflare Workers AI で画像を説明できませんでした。' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
