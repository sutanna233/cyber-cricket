'use strict';

// MiniMax 同步中文配音。密钥仅来自本次显式配置，不读取环境变量、不落盘。
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo']);

function error(code, message) {
  return Object.assign(new Error(message), { name: 'CommentarySpeechError', code: code });
}

function abortError() {
  return Object.assign(error('ABORT_ERR', '已取消解说配音'), { name: 'AbortError' });
}

function validateSpeechConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('TTS_CONFIG', '请填写解说配音的接口配置和 API Key');
  const baseUrl = input.baseUrl === undefined ? 'https://api.minimax.cn/v1' : typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const model = input.model === undefined ? 'speech-2.8-hd' : typeof input.model === 'string' ? input.model.trim() : '';
  const voiceId = input.voiceId === undefined ? 'male-qn-qingse' : typeof input.voiceId === 'string' ? input.voiceId.trim() : '';
  const speed = input.speed === undefined ? 1.08 : input.speed;
  if (!baseUrl || baseUrl.length > 2048 || /[\u0000-\u001f\u007f]/u.test(baseUrl) ||
      !apiKey || apiKey.length > 8192 || /[^\x21-\x7e]/u.test(apiKey)) {
    throw error('TTS_CONFIG', '请检查配音接口地址和 API Key 的格式');
  }
  if (!MODELS.has(model)) throw error('TTS_CONFIG', '配音模型请选择 speech-2.8-hd、speech-2.8-turbo、speech-2.6-hd 或 speech-2.6-turbo');
  if (!/^[A-Za-z0-9][A-Za-z0-9 _().:-]{0,99}$/u.test(voiceId)) throw error('TTS_CONFIG', '配音音色 ID 格式不正确，长度须在 100 个字符以内');
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw error('TTS_CONFIG', '配音语速须为 0.5 到 2 之间的数字');
  let url;
  try { url = new URL(baseUrl); } catch (_) { throw error('TTS_CONFIG', '配音接口地址格式不正确'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname) && url.hostname.split('.').every(part => Number(part) <= 255);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw error('TTS_CONFIG', '配音接口须使用 HTTPS 或本机 HTTP，地址中不能包含账号、密码、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return { baseUrl: url.toString().replace(/\/$/u, ''), apiKey: apiKey, model: model, voiceId: voiceId, speed: speed };
}

function endpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1/t2a_v2';
  else if (!url.pathname.endsWith('/t2a_v2')) url.pathname += '/t2a_v2';
  return url.toString();
}

async function readBody(response, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw error('TTS_RESPONSE_TOO_LARGE', '配音服务返回内容过大，请缩短解说后重试');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw error('TTS_RESPONSE', '无法读取配音服务返回内容');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw error('TTS_RESPONSE_TOO_LARGE', '配音服务返回内容过大，请缩短解说后重试');
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

// 时长以实际 RIFF 数据为准，服务的 extra_info 仅是提示，不能控制录像时间轴。
function inspectWave(buffer) {
  const invalid = () => error('TTS_INVALID_AUDIO', '配音服务没有返回有效的中文 WAV 音频');
  if (buffer.length < 44 || buffer.length > MAX_AUDIO_BYTES || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  const limit = buffer.readUInt32LE(4) + 8;
  if (limit < 44 || limit > buffer.length) throw invalid();
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= limit;) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (size > limit - start) throw invalid();
    if (name === 'fmt ') {
      if (format || size < 16) throw invalid();
      format = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14) };
    } else if (name === 'data') {
      if (data) throw invalid();
      data = { start: start, size: size };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data || !data.size || format.channels !== 1 || format.sampleRate !== 32000 ||
      !((format.codec === 1 && [8, 16, 24, 32].includes(format.bits)) || (format.codec === 3 && format.bits === 32)) ||
      format.blockAlign !== format.bits / 8 || format.byteRate !== format.sampleRate * format.blockAlign || data.size % format.blockAlign) throw invalid();
  const duration = data.size / format.byteRate;
  if (duration < 0.05 || duration > 45) throw invalid();
  let audible = false;
  for (let offset = data.start; offset < data.start + data.size; offset += format.blockAlign) {
    let sample;
    if (format.codec === 3) sample = buffer.readFloatLE(offset);
    else if (format.bits === 8) sample = (buffer.readUInt8(offset) - 128) / 128;
    else if (format.bits === 16) sample = buffer.readInt16LE(offset) / 32768;
    else if (format.bits === 24) sample = buffer.readIntLE(offset, 3) / 8388608;
    else sample = buffer.readInt32LE(offset) / 2147483648;
    if (!Number.isFinite(sample)) throw invalid();
    if (Math.abs(sample) > 0.00025) audible = true;
  }
  if (!audible) throw error('TTS_INVALID_AUDIO', '配音服务返回了静音，请更换音色或稍后重试');
  return { duration: duration, sampleRate: format.sampleRate, channels: format.channels, bytes: buffer.length };
}

async function synthesize(text, outputPath, options) {
  const opts = options || {};
  if (opts.signal && opts.signal.aborted) throw abortError();
  const config = validateSpeechConfig(opts.config);
  if (typeof text !== 'string' || !text.trim() || Array.from(text.trim()).length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw error('TTS_INVALID_TEXT', '每段解说配音须为 1 到 120 个字符');
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.wav') {
    throw error('TTS_INVALID_PATH', '配音输出须为服务器临时目录中的 WAV 文件');
  }
  if (typeof fetch !== 'function') throw error('TTS_UNAVAILABLE', '当前服务器需要 Node.js 18 或更新版本才能调用配音服务');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.min(TIMEOUT_MS, opts.timeoutMs)) : TIMEOUT_MS;
  let timedOut = false, created = false, success = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (opts.signal && opts.signal.aborted) throw abortError();
    // 禁止重定向，避免把本次显式指定接口的密钥发往另一个地址。
    const response = await fetch(endpoint(config.baseUrl), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({ model: config.model, text: text.trim(), stream: false, output_format: 'hex',
        voice_setting: { voice_id: config.voiceId, speed: config.speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, format: 'wav', channel: 1 },
        language_boost: 'Chinese', subtitle_enable: false }),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw error('TTS_AUTH', '配音服务认证失败，请检查本次配音 API Key');
      if (response.status === 429) throw error('TTS_RATE_LIMIT', '配音服务请求过于频繁，请稍后重试');
      throw error('TTS_SERVICE', '配音服务请求失败，请检查接口配置或稍后重试');
    }
    let payload;
    const raw = await readBody(response, controller.signal);
    try { payload = JSON.parse(raw); } catch (_) { throw error('TTS_RESPONSE', '配音服务没有返回有效的 JSON 内容'); }
    if (!payload || !payload.base_resp || payload.base_resp.status_code !== 0) {
      throw error('TTS_SERVICE', '配音服务拒绝本次合成，请检查密钥、额度和音色配置');
    }
    const audioHex = payload.data && payload.data.audio;
    if (!payload.data || payload.data.status !== 2 || typeof audioHex !== 'string' || !audioHex.length ||
        audioHex.length > MAX_AUDIO_BYTES * 2 || audioHex.length % 2 || !/^[a-f0-9]+$/iu.test(audioHex)) {
      throw error('TTS_INVALID_AUDIO', '配音服务没有返回完整的 WAV 音频');
    }
    const buffer = Buffer.from(audioHex, 'hex');
    const info = inspectWave(buffer);
    if (controller.signal.aborted) throw abortError();
    let file;
    try {
      file = await fs.open(outputPath, 'wx', 0o600);
      created = true;
      await file.writeFile(buffer);
    } catch (cause) {
      throw error(cause && cause.code === 'EEXIST' ? 'TTS_OUTPUT_EXISTS' : 'TTS_OUTPUT', '无法保存临时解说配音文件，请重新生成');
    } finally { if (file) await file.close(); }
    if (controller.signal.aborted) throw abortError();
    success = true;
    return Object.assign(info, { voice: config.voiceId });
  } catch (cause) {
    if (opts.signal && opts.signal.aborted) throw abortError();
    if (timedOut) throw error('TTS_TIMEOUT', '配音服务响应超时，请稍后重试');
    if (cause && cause.name === 'CommentarySpeechError') throw cause;
    throw error('TTS_NETWORK', '无法连接配音服务，请检查接口地址或网络后重试');
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    if (created && !success) await fs.unlink(outputPath).catch(() => {});
  }
}

module.exports = { validateSpeechConfig, synthesize };
