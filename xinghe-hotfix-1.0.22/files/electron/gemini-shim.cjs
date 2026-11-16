'use strict';
/**
 * Gemini 协议 → OpenAI 兼容协议 翻译层
 *
 * 背景：前端有一批调用走 Google 原生形态（`{base}/v1beta/models/{model}:generateContent`
 * 或 `:streamGenerateContent?alt=sse`），而我们的可用额度在 aicost（只有 OpenAI 兼容接口）。
 * 原版默认 geminiUrl 就是 `https://api.mmg.lat`（一个模仿 Google 路径的中转），所以这里
 * 直接在该路径上做协议转换，前端一行代码都不用改。
 */

function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
}

function collectSystem(body) {
  const out = [];
  const si = body.systemInstruction || body.system_instruction;
  if (si) {
    const t = partsToText(si.parts || si.content?.parts);
    if (t) out.push(t);
  }
  if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) out.push(body.systemPrompt.trim());
  return out.join('\n\n');
}

/** Gemini 请求体 → OpenAI messages */
function toMessages(body) {
  const msgs = [];
  const sys = collectSystem(body || {});
  if (sys) msgs.push({ role: 'system', content: sys });
  const contents = Array.isArray(body && body.contents) ? body.contents : [];
  for (const c of contents) {
    if (!c) continue;
    const role = c.role === 'model' || c.role === 'assistant' ? 'assistant' : 'user';
    const parts = Array.isArray(c.parts) ? c.parts : [];
    const texts = [];
    const images = [];
    for (const p of parts) {
      if (!p) continue;
      if (typeof p.text === 'string') texts.push(p.text);
      const inline = p.inline_data || p.inlineData;
      if (inline && inline.data) {
        const mime = inline.mime_type || inline.mimeType || 'image/png';
        images.push(`data:${mime};base64,${String(inline.data).replace(/\s/g, '')}`);
      }
    }
    const text = texts.join('\n');
    if (images.length) {
      const content = [{ type: 'text', text: text || '请描述这张图片。' }];
      for (const u of images) content.push({ type: 'image_url', image_url: { url: u } });
      msgs.push({ role, content });
    } else if (text) {
      msgs.push({ role, content: text });
    }
  }
  // 合并连续同角色，避免部分中转报错
  const merged = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else merged.push(m);
  }
  return merged;
}

function toOpenAIRequest(body, model) {
  const cfg = (body && (body.generationConfig || body.generation_config)) || {};
  const req = {
    model,
    messages: toMessages(body),
    stream: false,
  };
  const temp = cfg.temperature != null ? Number(cfg.temperature) : (body && body.temperature != null ? Number(body.temperature) : NaN);
  if (Number.isFinite(temp)) req.temperature = temp;
  const topP = cfg.topP != null ? Number(cfg.topP) : (body && body.top_p != null ? Number(body.top_p) : NaN);
  if (Number.isFinite(topP)) req.top_p = topP;
  const maxTok = cfg.maxOutputTokens != null ? Number(cfg.maxOutputTokens) : NaN;
  if (Number.isFinite(maxTok) && maxTok > 0) req.max_tokens = maxTok;
  return req;
}

/** OpenAI 非流式响应 → Gemini 形态 */
function toGeminiResponse(j) {
  const choices = Array.isArray(j && j.choices) ? j.choices : [];
  const text = choices.map((c) => String((c && c.message && c.message.content) || '')).join('');
  const finish = choices[0] && choices[0].finish_reason;
  const usage = (j && j.usage) || {};
  return {
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: finish === 'length' ? 'MAX_TOKENS' : 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: Number(usage.prompt_tokens) || 0,
      candidatesTokenCount: Number(usage.completion_tokens) || 0,
      totalTokenCount: Number(usage.total_tokens) || 0,
    },
    modelVersion: String((j && j.model) || ''),
  };
}

/** OpenAI 流式增量 → Gemini SSE 数据行 */
function streamChunk(text, done) {
  const payload = {
    candidates: [{
      content: { parts: done ? [] : [{ text }], role: 'model' },
      finishReason: done ? 'STOP' : undefined,
      index: 0,
    }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

module.exports = { toOpenAIRequest, toGeminiResponse, streamChunk, toMessages };
