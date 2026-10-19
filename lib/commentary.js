'use strict';

// 仅用于管理员录像：复盘事实 → 用户选择的大模型 → 中文语音 → 有时间轴的解说。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildFacts } = require('./commentary-facts');
const model = require('./commentary-model');
const { synthesize, validateSpeechConfig } = require('./commentary-speech');

const ROOT = path.resolve(__dirname, '../data/commentary');
const TTL = 30 * 60 * 1000;
const jobs = new Map();
let activeId = null;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function owned(id, owner) {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) throw error('解说任务不存在或已过期', 404);
  return job;
}

async function clean(job) {
  // 只清理本模块创建的单个随机任务目录，不能递归删除缓存根目录。
  if (!/^[a-f0-9]{32}$/.test(job.id) || job.dir !== path.join(ROOT, job.id)) throw error('无效的临时目录');
  await fs.rm(job.dir, { recursive: true, force: true });
}

function snapshot(job) {
  const out = { id: job.id, state: job.state, completed: job.completed, total: job.total };
  if (job.state === 'error') out.error = job.error;
  if (job.state === 'ready') Object.assign(out, {
    model: job.model, voice: job.voice, finalHash: job.finalHash,
    durationTicks: job.durationTicks, endSeconds: job.endSeconds,
    segments: job.segments.map((s, i) => ({ ...s, audioUrl: '/api/admin/commentary/' + job.id + '/audio/' + i })),
  });
  return out;
}

async function run(job, config, provider, speech) {
  const signal = job.controller.signal;
  try {
    job.state = 'analyzing';
    const facts = buildFacts(config);
    if (signal.aborted) throw error('已取消解说生成');
    job.state = 'writing';
    const script = await model.generateScript(facts, { config: provider, signal });
    provider = null; // 密钥只用于本次模型请求，不放入任务、文件、返回值或录像JSON。
    if (signal.aborted) throw error('已取消解说生成');
    await fs.mkdir(job.dir, { recursive: true, mode: 0o700 });
    job.state = 'voicing'; job.total = script.segments.length;
    const byId = new Map(facts.facts.map(f => [f.id, f]));
    const ready = [];
    for (let i = 0; i < script.segments.length; i++) {
      if (signal.aborted) throw error('已取消解说生成');
      const segment = script.segments[i], fact = byId.get(segment.factId);
      if (!fact) throw error('解说引用了不存在的战况');
      const file = path.join(job.dir, i + '.wav');
      const audio = await synthesize(segment.text, file, { config: speech, signal });
      ready.push({ factId: fact.id, type: fact.type, text: segment.text,
        eventTick: fact.tick, start: fact.tick / 60, duration: audio.duration, file });
      job.voice = audio.voice; job.completed++;
    }
    // 保留每句对应的事件时刻；过密的普通点评让位，结局完整收尾。
    let end = -0.25;
    const scheduled = [];
    for (const line of ready) {
      const start = Math.max(line.start, end + 0.25);
      if (line.type !== 'result' && (start - line.start > 2 || start + line.duration > facts.durationSeconds + 0.2)) continue;
      scheduled.push({ ...line, start, end: start + line.duration });
      end = start + line.duration;
    }
    if (!scheduled.length || scheduled[scheduled.length - 1].type !== 'result') throw error('解说缺少比赛结局，请重试生成');
    job.files = scheduled.map(s => s.file);
    job.segments = scheduled.map(({ file, ...s }) => s);
    job.finalHash = facts.finalHash; job.durationTicks = facts.durationTicks;
    job.endSeconds = Math.max(facts.durationSeconds + 1.5, end + 0.4);
    job.model = script.model; job.state = 'ready';
  } catch (cause) {
    job.state = signal.aborted ? 'cancelled' : 'error';
    // 外部模型模块和TTS模块仅产生经过脱敏的用户错误。
    job.error = cause && (cause.name === 'CommentaryModelError' || cause.code && String(cause.code).startsWith('TTS_'))
      ? cause.message : '解说生成失败，请检查模型与配音配置后重试';
    await clean(job).catch(() => {});
  } finally {
    provider = null; speech = null;
    if (activeId === job.id) activeId = null;
  }
}

function create(owner, config, provider, speech) {
  if (activeId) throw error('已有解说正在生成，请稍后再试', 429);
  // 不将不完整的用户配置与服务器密钥混用。
  provider = model.validateConfig(provider);
  speech = validateSpeechConfig(speech);
  const id = crypto.randomBytes(16).toString('hex');
  const job = { id, owner, dir: path.join(ROOT, id), created: Date.now(), state: 'queued',
    controller: new AbortController(), completed: 0, total: 0, files: [], segments: [] };
  jobs.set(id, job); activeId = id;
  job.promise = Promise.resolve().then(() => run(job, config, provider, speech));
  return snapshot(job);
}

function get(id, owner) { return snapshot(owned(id, owner)); }

async function audio(id, index, owner) {
  const job = owned(id, owner);
  if (job.state !== 'ready' || !Number.isInteger(index) || index < 0 || index >= job.files.length) throw error('语音不存在', 404);
  return fs.readFile(job.files[index]);
}

async function remove(id, owner) {
  const job = owned(id, owner);
  job.controller.abort();
  await job.promise;
  await clean(job); jobs.delete(id);
}

const cleanupTimer = setInterval(() => {
  for (const job of jobs.values()) if (Date.now() - job.created > TTL) remove(job.id, job.owner).catch(() => {});
}, 60000);
cleanupTimer.unref();

module.exports = { create, get, audio, remove };
