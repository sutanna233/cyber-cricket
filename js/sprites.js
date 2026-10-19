/* ===========================================================
   赛博斗蛐蛐 · 放置 ARPG —— 精灵层（投影 + 单位绘制 + 镜头）
   CC.sprites：
     project(x,z,h)         斜角俯视投影（世界 1200×700 平面 + 高度 h）
     drawShadow(ctx,ent)    地面投影
     drawUnit(ctx,ent,opt)  贴图单位（呼吸/摇摆/前扑/闪白/翻转/眩晕自转/KO）
     depthSort(list)        按 z 升序（越靠前越后画）
   表现层只读引擎数据，不改任何模拟量。
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util || {};
  const clamp = U.clamp || function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  const lerp = U.lerp || function (a, b, t) { return a + (b - a) * t; };
  const ease = U.ease || { outQuad: function (t) { return 1 - (1 - t) * (1 - t); } };

  // ---------------------------------------------------------------- 视图常量
  const VIEW = {
    W: 960, H: 600,
    SCALE: 0.8,        // 世界 x → 屏幕（1200 * 0.8 = 960，正好一个画布宽）
    KZ: 0.42,          // 世界 z 的透视压缩
    FLOOR_CY: 330,     // 世界 z 中心线落在屏幕上的 y
    H_MUL: 1.0,        // 贴图高度的视觉放大
    WORLD_W: 1200, WORLD_H: 700,
  };
  VIEW.ZS = VIEW.SCALE * VIEW.KZ;     // z → 屏幕 y 系数 ≈ 0.336

  const CAM = {
    x: VIEW.WORLD_W / 2, z: VIEW.WORLD_H / 2,
    tx: VIEW.WORLD_W / 2, tz: VIEW.WORLD_H / 2,
    shakeX: 0, shakeY: 0,
    PAN_X: 74, PAN_Z: 42,
    FOLLOW_RATE: 3.0,
    enabled: true,
  };

  // ---------------------------------------------------------------- 投影
  function project(x, z, h) {
    const px = (x === undefined ? 0 : x) - CAM.x;
    const pz = (z === undefined ? 0 : z) - CAM.z;
    const hh = h === undefined ? 0 : h;
    return {
      sx: VIEW.W / 2 + px * VIEW.SCALE + CAM.shakeX,
      sy: VIEW.FLOOR_CY + pz * VIEW.ZS - hh * VIEW.SCALE + CAM.shakeY,
    };
  }

  // 世界长度 → 屏幕长度（用于半径、圈、AOE）
  function scaleX(w) { return w * VIEW.SCALE; }
  function scaleZ(z) { return z * VIEW.ZS; }

  function setCamera(x, z, snap) {
    CAM.x = x; CAM.z = z; CAM.tx = x; CAM.tz = z;
    if (snap) { /* 已经是瞬间到位 */ }
  }
  function setShake(dx, dy) {
    CAM.shakeX = dx || 0;
    CAM.shakeY = dy || 0;
  }
  function camera() { return { x: CAM.x, z: CAM.z, targetX: CAM.tx, targetZ: CAM.tz, shakeX: CAM.shakeX, shakeY: CAM.shakeY }; }
  function centerCamera() { setCamera(VIEW.WORLD_W / 2, VIEW.WORLD_H / 2); }

  // 轻微跟随双方存活单位的重心（自动，无需输入）
  function followCamera(list, dt, opt) {
    const o = opt || {};
    const arr = Array.isArray(list) ? list : [];
    let sx = 0, sz = 0, n = 0, ax = 0, az = 0;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!e || e.alive === false) continue;
      if (typeof e.x !== 'number' || typeof e.z !== 'number') continue;
      sx += e.x; sz += e.z; n++;
      if (e.side === 'A' || e.side === 0) { ax += e.x; az += e.z; }
    }
    if (!n) { CAM.tx = VIEW.WORLD_W / 2; CAM.tz = VIEW.WORLD_H / 2; }
    else {
      CAM.tx = sx / n; CAM.tz = sz / n;
      // 双方都活着时，重心天然在中间；单方存活时把它拉回场内
      if (o.keepTogether && (o.aliveA !== undefined && o.aliveB !== undefined)) {
        if (!o.aliveA || !o.aliveB) { CAM.tx = lerp(sx / n, VIEW.WORLD_W / 2, 0.55); }
      }
    }
    CAM.tx = clamp(CAM.tx, VIEW.WORLD_W / 2 - CAM.PAN_X, VIEW.WORLD_W / 2 + CAM.PAN_X);
    CAM.tz = clamp(CAM.tz, VIEW.WORLD_H / 2 - CAM.PAN_Z, VIEW.WORLD_H / 2 + CAM.PAN_Z);
    const k = clamp((dt || 0) * CAM.FOLLOW_RATE, 0, 1);
    CAM.x = lerp(CAM.x, CAM.tx, k);
    CAM.z = lerp(CAM.z, CAM.tz, k);
  }

  // ---------------------------------------------------------------- 排序 / 尺寸
  function depthSort(list) {
    const arr = Array.isArray(list) ? list.slice() : [];
    arr.sort(function (a, b) {
      const za = (a && typeof a.z === 'number') ? a.z : 0;
      const zb = (b && typeof b.z === 'number') ? b.z : 0;
      if (za === zb) {
        const xa = (a && typeof a.x === 'number') ? a.x : 0;
        const xb = (b && typeof b.x === 'number') ? b.x : 0;
        return xa - xb;
      }
      return za - zb;
    });
    return arr;
  }

  function unitOf(ent) {
    if (!ent) return {};
    if (ent.unit) return ent.unit;
    const f = CC.fighters;
    if (f && f.get) {
      const u = f.get(ent.unitId || ent.id);
      if (u) return u;
    }
    return {};
  }

  function knownKey(key) {
    if (key === undefined || key === null || key === '') return false;
    const A = CC.assets;
    if (A && A.texture && A.texture(key)) return true;
    const f = CC.fighters;
    return !!(f && f.get && f.get(key));
  }

  // 贴图键解析：召唤物 unitId 是 'minion_<id>'（引擎约定），要还原成主人贴图，
  // 否则会退回占位色块（曾经在实机里看到紫色占位方块就是这个原因）。
  function spriteKey(ent) {
    const u = unitOf(ent);
    const cands = [];
    if (ent && ent.textureKey) cands.push(ent.textureKey);
    if (u.texture && u.texture.key) cands.push(u.texture.key);
    if (u.id) cands.push(u.id);
    if (ent && ent.unitId) cands.push(String(ent.unitId));
    if (ent && ent.of) cands.push(String(ent.of));
    for (let i = 0; i < cands.length; i++) if (knownKey(cands[i])) return cands[i];
    for (let i = 0; i < cands.length; i++) {
      const s = String(cands[i]).replace(/^minion_/, '').replace(/^summon_/, '');
      if (s !== String(cands[i]) && knownKey(s)) return s;
    }
    for (let i = 0; i < cands.length; i++) {
      const s = String(cands[i]).replace(/^minion_/, '');
      if (knownKey(s)) return s;
    }
    return cands[0] || 'unknown';
  }

  function spriteSize(ent, opt) {
    const o = opt || {};
    const u = unitOf(ent);
    const texScale = (u.texture && u.texture.scale) || 1;
    let h = (u.height || 78) * VIEW.H_MUL * (o.scale === undefined ? 1 : o.scale) * texScale;
    let aspect = o.aspect;
    if (!aspect) {
      const A = CC.assets;
      const key = spriteKey(ent);
      let box = null;
      if (A && A.contentBox) box = A.contentBox(key);
      if (box && box.w > 0 && box.h > 0) aspect = box.w / box.h;
      else if (box && box.x1 >= box.x0 && box.y1 >= box.y0) {
        aspect = (box.x1 - box.x0 + 1) / (box.y1 - box.y0 + 1);
      } else aspect = 0.86;
    }
    aspect = clamp(aspect, 0.5, 1.6);
    return { w: h * aspect, h: h };
  }

  // ---------------------------------------------------------------- 姿态
  // 尸体淡出：引擎给死亡实体累加 deadT，1.4s（召唤物 0.25s）后从数组移除
  function corpseDur(ent) { return (ent && ent.isMinion) ? 0.25 : 1.4; }
  function corpseK(ent) {
    const d = (ent && typeof ent.deadT === 'number' && ent.deadT > 0)
      ? ent.deadT : ((ent && typeof ent.stateT === 'number') ? ent.stateT : 0);
    return clamp(d / corpseDur(ent), 0, 1);
  }

  function poseOf(ent, t, opt) {
    const o = opt || {};
    const st = ent.state || (ent.alive === false ? 'ko' : 'idle');
    const stT = typeof ent.stateT === 'number' ? ent.stateT : 0;
    const phase = ((ent.slot || 0) * 1.7 + (ent.side === 'B' ? 0.9 : 0));
    const superArmor = !!(ent.buffs && ent.buffs.some(function (b) { return b && b.kind === 'superArmor'; }));
    const p = {
      rot: 0, bobY: 0, sqx: 1, sqy: 1, fwd: 0, alpha: (o.alpha === undefined ? 1 : o.alpha), flash: o.flash || 0,
      lean: 0, sink: 0,
    };
    // 呼吸（任何状态下都保留一点生命感）
    const br = Math.sin(t * 2.2 + phase);
    p.sqx *= 1 - 0.018 * br;
    p.sqy *= 1 + 0.028 * br;

    if (st === 'walk' || st === 'run') {
      const w = Math.sin(t * (st === 'run' ? 15 : 7.4) + phase);
      p.bobY = -Math.abs(w) * 3.4;
      p.rot = w * 0.055;
      p.sqx *= 1 + 0.02 * w;
    } else if (st === 'attack' || st === 'cast') {
      const dur = o.attackDur || 0.34;
      const k = clamp(stT / Math.max(0.08, dur), 0, 1);
      if (k < 0.34) {                                  // 压缩蓄力
        const a = k / 0.34;
        p.sqx *= 1 + 0.12 * a;
        p.sqy *= 1 - 0.12 * a;
        p.fwd = -7 * a;
        p.rot = -0.06 * a;
      } else {                                          // 前扑拉伸
        const a = (k - 0.34) / 0.66;
        const s = Math.sin(Math.PI * a);
        p.fwd = 26 * ease.outQuad(clamp(a * 1.6, 0, 1));
        p.sqx *= 1 + 0.10 * s;
        p.sqy *= 1 - 0.08 * s;
        p.rot = 0.08 * s;
      }
    } else if (st === 'dash') {
      p.sqx *= 1.18;
      p.sqy *= 0.87;
      p.fwd = 12;
      p.rot = 0.12;
      p.lean = 1;
      if (ent.dash && ent.dash.step.jumpHeight) {
        p.rot = 0.85 * (ent.facing === -1 ? -1 : 1);
        p.sqx *= 1.08; p.sqy *= 0.9;
      }
    } else if (st === 'hurt') {
      const j = Math.sin(t * 78 + phase);
      p.rot = j * 0.07;
      p.fwd = -4 - Math.abs(j) * 3;
      p.sqx *= 1.05; p.sqy *= 0.95;
      p.flash = Math.max(p.flash, 0.85);
    } else if (st === 'stun') {
      // 眩晕自转：整体摇晃 + 横向压缩模拟转身
      const spin = t * 3.1 + phase;
      p.rot = Math.sin(spin) * 0.12;
      p.bobY = Math.sin(t * 4.2 + phase) * 2.6 - 2;
      p.sqx *= 0.82 + 0.18 * Math.abs(Math.cos(spin * 0.5));
      p.lean = Math.abs(Math.sin(spin * 0.5));
    } else if (st === 'charge' || st === 'ult') {
      // 蓄力前摇：蹲身压缩 + 随进度增强的抖动
      const cd = ent.cast || {};
      const prog = clamp(((cd.chargeT || 0) / Math.max(0.05, cd.chargeDur || 0.5)), 0, 1);
      const tremble = 0.4 + 1.8 * prog;
      p.rot = Math.sin(t * 42 + phase) * 0.014 * tremble;
      p.sqx *= 1 + 0.10 * prog;
      p.sqy *= 1 - 0.09 * prog;
      p.bobY = -1.5 - 2.5 * prog;
      p.fwd = -3 * prog;
      if (prog > 0.75) p.flash = Math.max(p.flash, (prog - 0.75) * 1.6);
    } else if (st === 'ko') {
      const k = corpseK(ent);            // deadT 驱动：1.4s 内翻倒 + 下坠 + 淡出
      const e = ease.outQuad(k);
      p.rot = e * 1.55 * (ent.facing === -1 ? -1 : 1);
      p.bobY = e * 20;
      p.alpha *= (1 - 0.94 * e);
      p.sqy *= 1 - 0.26 * e;
      p.sqx *= 1 + 0.12 * e;
      p.sink = e;
    } else {
      const micro = Math.sin(t * 1.35 + phase * 1.7);
      p.rot = micro * 0.018;
      p.bobY = -0.6;
    }
    if (superArmor) p.sqx *= 1.03;
    if (typeof o.extraRot === 'number') p.rot += o.extraRot;
    return p;
  }

  // ---------------------------------------------------------------- 画图工具
  function rr(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    if (ctx.quadraticCurveTo) {
      ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
      ctx.lineTo(x + w, y + h - rad);
      ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      ctx.lineTo(x + rad, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
      ctx.lineTo(x, y + rad);
      ctx.quadraticCurveTo(x, y, x + rad, y);
    } else {
      ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
    }
    ctx.closePath();
  }

  function ellipsePath(ctx, cx, cy, rx, ry) {
    if (ctx.ellipse) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.scale(1, Math.max(0.0001, ry / Math.max(0.01, rx)));
    ctx.arc(cx, cy / Math.max(0.0001, ry / Math.max(0.01, rx)), Math.max(0.01, rx), 0, Math.PI * 2);
    ctx.restore();
  }

  // 按内容框裁切绘制，保持角色体量一致。
  function drawTrimmed(ctx, img, key, dx, dy, dw, dh) {
    const A = CC.assets;
    let box = null;
    if (A && A.contentBox) box = A.contentBox(key);
    const iw = (img.naturalWidth || img.width || 0);
    const ih = (img.naturalHeight || img.height || 0);
    if (box && box.x1 !== undefined && (box.x1 - box.x0) > 1 && (box.y1 - box.y0) > 1 && iw && ih) {
      ctx.drawImage(img, box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, dx, dy, dw, dh);
    } else if (iw && ih) {
      ctx.drawImage(img, dx, dy, dw, dh);
    } else if (ctx.drawImage) {
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { /* 忽略 */ }
    }
  }

  // 通用精灵绘制（fx 也走这里）：以 (cx,cy) 为中心
  function drawSprite(ctx, key, cx, cy, w, h, opt) {
    const o = opt || {};
    const A = CC.assets;
    const img = A && A.texture ? A.texture(key) : null;
    ctx.save();
    ctx.translate(cx, cy);
    if (o.rot && ctx.rotate) ctx.rotate(o.rot);
    if (o.mirror && ctx.scale) ctx.scale(-1, 1);
    if (typeof o.alpha === 'number') ctx.globalAlpha = o.alpha;
    if ('globalCompositeOperation' in ctx && o.blend) ctx.globalCompositeOperation = o.blend;
    if (img) {
      if (o.trim) drawTrimmed(ctx, img, key, -w / 2, -h / 2, w, h);
      else ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // 无贴图：画发光色块兜底（fx 一般由渲染层画矢量，这里只兜最底一层）
      if (o.color) {
        ctx.fillStyle = o.color;
        ellipsePath(ctx, 0, 0, w / 2, h / 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 影子
  function drawShadow(ctx, ent, opt) {
    if (!ent) return;
    const o = opt || {};
    if (ent.su7 && ent.alive !== false) {
      const p = project(ent.x, ent.z, 0);
      ctx.save(); ctx.fillStyle = 'rgba(3,6,16,0.45)';
      ellipsePath(ctx, p.sx, p.sy, 78, 17); ctx.fill(); ctx.restore(); return;
    }
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, 0);
    const hh = typeof ent.h === 'number' ? ent.h : 0;
    const k = clamp(1 - hh / 170, 0.25, 1);
    const w = s.w * (1.05 + 0.28 * k) * 1.05;
    const h = w * 0.5;
    const alpha = (o.alpha === undefined ? 1 : o.alpha) * 0.5 * k;
    const A = CC.assets;
    const img = A && A.texture ? A.texture('shadow') : null;
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;
    if (img) {
      ctx.drawImage(img, p.sx - w / 2, p.sy - h / 2, w, h);
    } else {
      ctx.fillStyle = 'rgba(3,6,16,0.75)';
      ellipsePath(ctx, p.sx, p.sy, w / 2, h / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 血条/名字
  const BAR = {
    hp: 6, energy: 3, gap: 2.5, nameGap: 5, minW: 42, maxW: 118,
  };
  function barColors(ratio) {
    if (ratio > 0.55) return ['#7dff9b', '#1c7a3a'];
    if (ratio > 0.28) return ['#ffd166', '#8a5a10'];
    return ['#ff5f6d', '#7a1420'];
  }

  function drawBars(ctx, ent, opt) {
    const o = opt || {};
    const u = unitOf(ent);
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, (ent.h || 0));
    const isBoss = u.role === 'boss';
    const w = clamp(s.w * (isBoss ? 1.5 : 1.0), BAR.minW, isBoss ? 190 : BAR.maxW);
    const x = p.sx - w / 2;
    let y = p.sy - s.h - (o.barLift === undefined ? 18 : o.barLift);
    const maxHp = Math.max(1, ent.maxHp || (u.stats && u.stats.hp) || 1);
    const ratio = clamp((ent.hp === undefined ? maxHp : ent.hp) / maxHp, 0, 1);
    const alpha = (o.barAlpha === undefined ? 1 : o.barAlpha) * (o.alpha === undefined ? 1 : o.alpha);
    if (alpha <= 0.02) return;
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;

    // 名字
    if (o.showName !== false && ctx.fillText) {
      ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const nm = (u.name || ent.unitId || '?') + (ent.brawl ? ' #' + ent.id : '');
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(nm, p.sx + 1, y + BAR.nameGap + 1);
      ctx.fillStyle = ent.side === 'B' ? '#ffd0d8' : '#d8f4ff';
      ctx.fillText(nm, p.sx, y + BAR.nameGap);
      y += BAR.nameGap + 2;
    }

    // 血条
    ctx.fillStyle = 'rgba(6,10,20,0.78)';
    rr(ctx, x - 1, y - 1, w + 2, BAR.hp + 2, 3); ctx.fill();
    const cols = barColors(ratio);
    if (ctx.createLinearGradient) {
      const gr = ctx.createLinearGradient(0, y, 0, y + BAR.hp);
      gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1]);
      ctx.fillStyle = gr;
    } else { ctx.fillStyle = cols[0]; }
    rr(ctx, x, y, Math.max(1, w * ratio), BAR.hp, 2.5); ctx.fill();
    // 护盾（叠在血条右侧）
    if (ent.shield > 0) {
      const sr = clamp(ent.shield / maxHp, 0, 1);
      ctx.fillStyle = 'rgba(150,235,255,0.9)';
      rr(ctx, x + w * (1 - sr) * ratio * 0 + w * Math.min(1, ratio), y, Math.min(w - w * ratio, w * sr), BAR.hp, 2); ctx.fill();
    }
    // 分段（Boss / 高血量单位）
    if (isBoss) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const gx = x + (w / 8) * i;
        ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + BAR.hp); ctx.stroke();
      }
    }
    // 怒气条
    const energy = clamp((ent.energy === undefined ? 0 : ent.energy) / 100, 0, 1);
    const ey = y + BAR.hp + BAR.gap;
    ctx.fillStyle = 'rgba(6,10,20,0.72)';
    rr(ctx, x - 1, ey - 1, w + 2, BAR.energy + 2, 2.5); ctx.fill();
    ctx.fillStyle = energy >= 1 ? '#fff2a8' : '#8fd6ff';
    rr(ctx, x, ey, Math.max(0, w * energy), BAR.energy, 2); ctx.fill();
    ctx.restore();
  }

  // 状态小图标（buff/debuff 点阵）
  const BUFF_COLORS = {
    stun: '#ffd166', blind: '#c8a8ff', poison: '#8affc1', speedUp: '#8ff0ff', speedDown: '#7d8cff',
    atkUp: '#ff9a5c', atkDown: '#9aa0b5', shield: '#7ce7ff', seal: '#ff6bd6', reflect: '#ffe066',
    invuln: '#ffffff', superArmor: '#ffb36b', regen: '#7dff9b', lifesteal: '#ff7d9c',
    guaranteedCrit: '#ff4d4d', taunt: '#ffa8d8', cleanse: '#c9ffd8', marked: '#ff3b3b',
  };

  // 石头（可拾取资源）程序化外形：6 边形 + 顶面高光，形状按 id 稳定
  function stonePath(ctx, cx, cy, r, seedId) {
    const h = (typeof seedId === 'number' ? seedId : 7) * 2654435761 % 4294967296;
    const n = 6;
    ictxBegin(ctx);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const rr2 = r * (0.78 + 0.22 * (((h >> (i * 3)) & 7) / 7));
      const x = cx + Math.cos(a) * rr2;
      const y = cy + Math.sin(a) * rr2 * 0.92;
      if (i === 0) { if (ctx.moveTo) ctx.moveTo(x, y); }
      else if (ctx.lineTo) ctx.lineTo(x, y);
    }
    if (ctx.closePath) ctx.closePath();
  }
  function ictxBegin(ctx) { if (ctx.beginPath) ctx.beginPath(); }

  function drawStone(ctx, cx, cy, r, seedId, glow) {
    ctx.save();
    stonePath(ctx, cx, cy, r, seedId);
    ctx.fillStyle = glow ? '#8a93a2' : '#6b7483';
    ctx.fill();
    if (ctx.stroke) {
      ctx.strokeStyle = 'rgba(12,16,22,0.92)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // 顶面高光
    if (ctx.beginPath) {
      ctx.beginPath();
      if (ctx.moveTo) ctx.moveTo(cx - r * 0.42, cy - r * 0.24);
      if (ctx.lineTo) { ctx.lineTo(cx + r * 0.2, cy - r * 0.5); ctx.lineTo(cx + r * 0.46, cy - r * 0.06); ctx.lineTo(cx - r * 0.1, cy + r * 0.12); }
      if (ctx.closePath) ctx.closePath();
      ctx.fillStyle = 'rgba(212,222,236,0.5)';
      ctx.fill();
    }
    ctx.restore();
  }

  // 地上可拾取物件（state.pickups）：石头 + 影子 + 上扬浮动；消失前 3 秒淡出
  function drawPickup(ctx, pk, opt) {
    if (!pk || typeof pk.x !== 'number') return;
    const o = opt || {};
    const t = (o.t === undefined ? 0 : o.t);
    const age = (typeof pk.t === 'number') ? pk.t : 0;
    const ttl = (typeof pk.ttl === 'number' && pk.ttl > 0) ? pk.ttl : 30;
    const remain = ttl - age;
    let alpha = clamp(remain / 3, 0, 1);                  // 最后 3 秒淡出
    if (alpha <= 0.02) return;
    if (o.alpha !== undefined) alpha *= o.alpha;
    const phase = ((pk.id || 0) % 7) * 0.9;
    const bob = 3.4 + Math.sin(t * 3.1 + phase) * 2.6;
    const ground = project(pk.x, pk.z, 0);
    const p = project(pk.x, pk.z, (pk.h || 0) + bob);
    const r = 9 + ((pk.id || 0) % 3);
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = 'rgba(3,6,16,0.8)';
    ellipsePath(ctx, ground.sx, ground.sy, r * 1.1, r * 0.5);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;
    const sparkle = 0.18 + 0.16 * Math.abs(Math.sin(t * 2.2 + phase));
    const A = CC.assets;
    const star = A && A.texture ? A.texture('star') : null;
    if (star) {
      ctx.save();
      if ('globalCompositeOperation' in ctx) ctx.globalCompositeOperation = 'lighter';
      if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha * sparkle;
      ctx.drawImage(star, p.sx - 14, p.sy - 14, 28, 28);
      ctx.restore();
    }
    if (pk.kind === 'stone' || !pk.kind) drawStone(ctx, p.sx, p.sy, r, pk.id, alpha < 0.99);
    else {
      ctx.fillStyle = '#b06bff';
      ellipsePath(ctx, p.sx, p.sy, r, r * 0.9);
      ctx.fill();
    }
    ctx.restore();
    // 剩余时间进度环（淡出提示）
    if (remain < 3 && remain > 0 && ctx.stroke) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = 'rgba(255,180,120,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(ground.sx, ground.sy + 2, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (remain / 3));
      ctx.stroke();
      ctx.restore();
    }
  }

  // 召唤物计数徽章（只统计当前存活的分身，0 个不画）
  function drawMinionBadge(ctx, ent, n, x, y, opt) {
    if (!n || n <= 0) return;
    ctx.save();
    ctx.fillStyle = 'rgba(28,14,48,0.88)';
    rr(ctx, x, y, 44, 17, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(200,160,255,0.85)';
    ctx.lineWidth = 1;
    rr(ctx, x + 0.5, y + 0.5, 43, 16, 5);
    if (ctx.stroke) ctx.stroke();
    // 小分身图标（两个小圆头）
    ctx.fillStyle = '#c8a8ff';
    ellipsePath(ctx, x + 9, y + 9, 4, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ellipsePath(ctx, x + 13.5, y + 7.5, 2.6, 2.6); ctx.fill();
    if (ctx.fillText) {
      ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#efe4ff';
      ctx.fillText('x' + n, x + 19, y + 9.5);
    }
    ctx.restore();
  }

  // 石头计数徽章（ent.stacks）：只在 >0 时显示
  function drawStacks(ctx, ent, opt) {
    const st = ent && ent.stacks;
    const o = opt || {};
    const minionN = o.minionCount || 0;
    if ((!st || !Object.keys(st).length) && !minionN) return;
    const keys = [];
    if (st) for (const k in st) { if (k !== 'pace' && k !== 'paceBoost' && (st[k] | 0) > 0) keys.push(k); }
    if (!keys.length && !minionN) return;              // 0 个：什么都不画
    if (ent.alive === false) return;
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, (ent.h || 0));
    const u = unitOf(ent);
    const tr = (u.trait) || ent.trait || null;
    const baseY = p.sy - s.h - (o.stackLift === undefined ? 30 : o.stackLift);
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = (o.alpha === undefined ? 1 : o.alpha);
    let bx = p.sx + s.w * 0.42;
    if (minionN > 0) { drawMinionBadge(ctx, ent, minionN, bx, baseY, o); bx += 48; }
    for (let i = 0; i < Math.min(2, keys.length); i++) {
      const k = keys[i];
      const n = st[k] | 0;
      const max = (tr && tr.collect === k && tr.max) ? tr.max : 10;
      const full = n >= max;
      const w = 34, h = 17;
      ctx.fillStyle = full ? 'rgba(72,26,10,0.9)' : 'rgba(8,12,22,0.85)';
      rr(ctx, bx, baseY, w, h, 5); ctx.fill();
      ctx.strokeStyle = full ? 'rgba(255,196,90,0.95)' : 'rgba(160,180,205,0.5)';
      ctx.lineWidth = 1;
      rr(ctx, bx + 0.5, baseY + 0.5, w - 1, h - 1, 5);
      if (ctx.stroke) ctx.stroke();
      drawStone(ctx, bx + 8, baseY + h / 2, 5.4, (ent.id || 0) + i, full);
      if (ctx.fillText) {
        ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = full ? '#ffe066' : '#e8f4ff';
        ctx.fillText('x' + n, bx + 15, baseY + h / 2 + 0.5);
      }
      if (full) {
        const pulse = 0.5 + 0.5 * Math.sin((o.t || 0) * 8);
        ctx.strokeStyle = 'rgba(255,220,120,' + (0.35 + 0.45 * pulse).toFixed(2) + ')';
        ctx.lineWidth = 2;
        rr(ctx, bx - 1.5, baseY - 1.5, w + 3, h + 3, 6);
        if (ctx.stroke) ctx.stroke();
      }
      bx += w + 4;
    }
    ctx.restore();
  }

  // 蓄力前摇：头顶蓄力条（s1/s2/ult 三色）+ 剩余秒数
  const CHARGE_COLORS = {
    s1: ['#8ff0ff', '#1c5c72'],
    s2: ['#ffd166', '#7a4d08'],
    s3: ['#a6f3ce', '#276245'],
    ult: ['#ff8ad8', '#7a1050'],
  };
  function drawCharge(ctx, ent, opt) {
    const cast = ent && ent.cast;
    if (!cast || !cast.charging || ent.alive === false) return;
    const o = opt || {};
    const key = cast.key || 's1';
    const dur = Math.max(0.05, cast.chargeDur || 0.5);
    const prog = clamp((cast.chargeT || 0) / dur, 0, 1);
    const col = CHARGE_COLORS[key] || CHARGE_COLORS.s1;
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, (ent.h || 0));
    const w = clamp(s.w * 0.95, 46, 130);
    const lift = (o.chargeLift === undefined ? 26 : o.chargeLift);
    const x = p.sx - w / 2;
    const y = p.sy - s.h - lift;
    const alpha = (o.alpha === undefined ? 1 : o.alpha);
    const t = o.t || 0;
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;
    // 底板
    ctx.fillStyle = 'rgba(6,10,20,0.85)';
    rr(ctx, x - 1.5, y - 1.5, w + 3, 9, 4); ctx.fill();
    // 进度
    if (ctx.createLinearGradient) {
      const g = ctx.createLinearGradient(0, y, 0, y + 6);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      ctx.fillStyle = g;
    } else ctx.fillStyle = col[0];
    rr(ctx, x, y, Math.max(1, w * prog), 6, 3); ctx.fill();
    // 尖端闪光
    const hx = x + w * prog;
    ctx.fillStyle = 'rgba(255,255,255,' + (0.5 + 0.5 * prog).toFixed(2) + ')';
    ellipsePath(ctx, hx, y + 3, 2.6, 2.6 + 1.4 * Math.sin(t * 18));
    ctx.fill();
    // 边框（必杀更亮）
    ctx.strokeStyle = key === 'ult' ? 'rgba(255,120,210,' + (0.5 + 0.5 * prog).toFixed(2) + ')' : 'rgba(160,200,230,0.55)';
    ctx.lineWidth = key === 'ult' ? 2 : 1;
    rr(ctx, x - 1.5, y - 1.5, w + 3, 9, 4);
    if (ctx.stroke) ctx.stroke();
    if (ctx.fillText) {
      ctx.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = key === 'ult' ? '#ffd0ee' : '#dff2ff';
      const label = key === 'ult' ? '必杀蓄力' : (key === 's3' ? (cast.skill.name || '技3') : key === 's2' ? '技2' : '技1');
      ctx.fillText(label + ' ' + Math.max(0, dur - (cast.chargeT || 0)).toFixed(1) + 's', p.sx, y - 3);
    }
    ctx.restore();
  }

  // 必杀前摇的大范围预警圈（地上，画在单位之前）
  function drawChargeWarn(ctx, ent, opt) {
    const cast = ent && ent.cast;
    if (!cast || !cast.charging || cast.key !== 'ult' || ent.alive === false) return;
    const o = opt || {};
    const dur = Math.max(0.05, cast.chargeDur || 1.4);
    const prog = clamp((cast.chargeT || 0) / dur, 0, 1);
    const t = o.t || 0;
    const radius = (ent.castRadius || 230) * (0.75 + 0.25 * prog);
    const p = project(ent.x, ent.z, 0);
    const rx = scaleX(radius), ry = scaleZ(radius);
    const pulse = 0.5 + 0.5 * Math.sin(t * 12);
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = 0.95;
    // 外圈虚线圈
    ctx.strokeStyle = 'rgba(255,110,200,' + (0.45 + 0.35 * pulse).toFixed(2) + ')';
    ctx.lineWidth = 2.5;
    if (ctx.setLineDash) ctx.setLineDash([9, 7]);
    ellipsePath(ctx, p.sx, p.sy, rx, ry);
    if (ctx.stroke) ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    // 进度填充
    ctx.fillStyle = 'rgba(255,80,190,' + (0.10 + 0.24 * prog).toFixed(3) + ')';
    ellipsePath(ctx, p.sx, p.sy, rx * prog, ry * prog);
    ctx.fill();
    ctx.restore();
  }
  function drawMarked(ctx, ent, opt) {
    const buffs = ent && ent.buffs;
    if (!buffs || !buffs.length) return;
    let marked = null;
    for (let i = 0; i < buffs.length; i++) if (buffs[i] && buffs[i].kind === 'marked') marked = buffs[i];
    if (!marked) return;
    const o = opt || {};
    const mag = clamp(marked.mag === undefined ? 0.3 : marked.mag, 0, 1);
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, (ent.h || 0));
    const t = o.t || 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    const alpha = (o.alpha === undefined ? 1 : o.alpha) * (ent.alive === false ? 0.4 : 1);
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;
    // 脉动红描边
    ctx.strokeStyle = 'rgba(255,58,58,' + (0.30 + 0.30 * pulse + 0.35 * mag).toFixed(2) + ')';
    ctx.lineWidth = 2 + 1.5 * mag;
    ellipsePath(ctx, p.sx, p.sy - s.h * 0.55, s.w * 0.62 * (1 + 0.03 * pulse), s.h * 0.6);
    if (ctx.stroke) ctx.stroke();
    // 头顶红印章（方框 + 叉）
    const bx = p.sx + s.w * 0.3, by = p.sy - s.h - 12 - 14 * mag;
    const r = 9 + 3 * mag;
    ctx.fillStyle = 'rgba(150,12,20,0.92)';
    rr(ctx, bx - r, by - r, r * 2, r * 2, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(255,120,120,0.95)';
    ctx.lineWidth = 1.6;
    rr(ctx, bx - r, by - r, r * 2, r * 2, 3);
    if (ctx.stroke) ctx.stroke();
    ctx.strokeStyle = 'rgba(255,235,235,0.95)';
    ctx.lineWidth = 2;
    if (ctx.beginPath) {
      ctx.beginPath();
      if (ctx.moveTo) { ctx.moveTo(bx - r * 0.45, by - r * 0.45); ctx.lineTo(bx + r * 0.45, by + r * 0.45); }
      if (ctx.moveTo) { ctx.moveTo(bx + r * 0.45, by - r * 0.45); ctx.lineTo(bx - r * 0.45, by + r * 0.45); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBuffs(ctx, ent, opt) {
    const o = opt || {};
    const buffs = ent.buffs;
    if (!buffs || !buffs.length) return;
    const u = unitOf(ent);
    const s = spriteSize(ent, { scale: o.scale });
    const p = project(ent.x, ent.z, (ent.h || 0));
    const n = Math.min(5, buffs.length);
    const r = 3.2;
    const totalW = n * (r * 2 + 2);
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = (o.alpha === undefined ? 1 : o.alpha) * 0.95;
    for (let i = 0; i < n; i++) {
      const b = buffs[i] || {};
      const cx = p.sx - totalW / 2 + r + i * (r * 2 + 2);
      const cy = p.sy - s.h - 30;
      ctx.fillStyle = BUFF_COLORS[b.kind] || '#cccccc';
      ellipsePath(ctx, cx, cy, r, r);
      ctx.fill();
      if (ctx.stroke) { ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.restore();
  }

  // 车内头像只在驾驶窗中绘制，常态角色不会再叠在车辆旁边。
  function drawSu7(ctx, ent, opt) {
    const o = opt || {}, drive = ent.su7 || {};
    const t = o.t || 0, dx = drive.dx == null ? (ent.facing || 1) : drive.dx, dz = drive.dz || 0;
    const facing = dx < 0 ? -1 : dx > 0 ? 1 : (ent.facing || 1);
    const turn = clamp(Math.atan2(dz * VIEW.ZS, Math.abs(dx) * VIEW.SCALE) * facing, -0.38, 0.38);
    const pt = project(ent.x, ent.z, 0);
    ctx.save(); ctx.translate(pt.sx, pt.sy + Math.sin(t * 34) * 0.7);
    ctx.rotate(turn); ctx.scale(facing, 1);
    ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    ctx.strokeStyle = 'rgba(166,233,255,0.5)'; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(-81 - i * 5, -15 - i * 8); ctx.lineTo(-103 - i * 8, -15 - i * 8); ctx.stroke();
    }
    // 流线车身、溜背车顶和低矮引擎盖。
    ctx.beginPath(); ctx.moveTo(-76, -10); ctx.lineTo(-72, -27);
    ctx.quadraticCurveTo(-68, -32, -43, -34); ctx.lineTo(-23, -51);
    ctx.quadraticCurveTo(5, -64, 36, -43); ctx.lineTo(47, -34);
    ctx.quadraticCurveTo(69, -33, 77, -22); ctx.lineTo(78, -9);
    ctx.quadraticCurveTo(73, -3, 60, -4); ctx.lineTo(-63, -4); ctx.closePath();
    if (ctx.createLinearGradient) {
      const paint = ctx.createLinearGradient(0, -56, 0, 0);
      paint.addColorStop(0, '#b4f0f3'); paint.addColorStop(0.45, '#42b5cb'); paint.addColorStop(1, '#12647f');
      ctx.fillStyle = paint;
    } else ctx.fillStyle = '#42b5cb';
    ctx.fill(); ctx.strokeStyle = '#b3f3ff'; ctx.lineWidth = 1.3; ctx.stroke();
    ctx.fillStyle = '#132c3b';
    ctx.beginPath(); ctx.moveTo(-36, -33); ctx.lineTo(-20, -47); ctx.lineTo(-9, -49);
    ctx.lineTo(-9, -32); ctx.closePath(); ctx.fill();
    // 驾驶窗及座椅。头像裁切保留原 PNG，不生成或改写素材。
    ctx.beginPath(); ctx.moveTo(-4, -49); ctx.quadraticCurveTo(15, -51, 28, -41);
    ctx.lineTo(37, -32); ctx.lineTo(-4, -32); ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = '#0b192a'; ctx.fillRect(-4, -40, 12, 14);
    const A = CC.assets, key = spriteKey(ent), img = A && A.texture ? A.texture(key) : null;
    if (img) {
      const box = A.contentBox ? A.contentBox(key) : null;
      const bx = box && box.x0 !== undefined ? box.x0 : 0;
      const by = box && box.y0 !== undefined ? box.y0 : 0;
      const bw = box && box.x1 !== undefined ? box.x1 - bx + 1 : (img.naturalWidth || img.width || 1);
      const bh = box && box.y1 !== undefined ? box.y1 - by + 1 : (img.naturalHeight || img.height || 1);
      ctx.drawImage(img, bx + bw * 0.50, by + bh * 0.14, bw * 0.29, bh * 0.56, -3, -51, 35, 39);
    } else {
      ctx.fillStyle = '#e9bb8b'; ellipsePath(ctx, 13, -40, 7, 8); ctx.fill();
    }
    ctx.restore();
    // 窗框遮住下身，方向盘与手位于车窗里，明确表现为坐着驾驶。
    ctx.strokeStyle = '#102b39'; ctx.lineWidth = 2.1;
    ctx.beginPath(); ctx.moveTo(-7, -49); ctx.lineTo(-7, -31); ctx.lineTo(38, -31); ctx.stroke();
    ellipsePath(ctx, 28, -32, 5, 4); ctx.stroke();
    ctx.strokeStyle = '#dfb68b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(16, -30); ctx.lineTo(25, -31); ctx.stroke();
    ctx.fillStyle = '#3a9db4'; rr(ctx, 33, -33, 10, 4, 2); ctx.fill();
    // 侧裙、门缝、门把手和 SU7 标识。
    ctx.strokeStyle = '#18778f'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-8, -30); ctx.lineTo(-9, -10); ctx.lineTo(37, -10); ctx.lineTo(41, -28); ctx.stroke();
    ctx.strokeStyle = '#a2e7ed'; ctx.beginPath(); ctx.moveTo(-60, -20); ctx.lineTo(64, -20); ctx.stroke();
    ctx.fillStyle = '#d1faff'; ctx.fillRect(22, -25, 8, 2);
    ctx.save(); ctx.translate(4, -12); ctx.scale(facing, 1);
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#e6fcff'; ctx.fillText('SU7', 0, 0);
    ctx.restore();
    ctx.fillStyle = '#082939'; ctx.fillRect(-62, -7, 126, 4);
    // 两个可见车轮和旋转轮辐。
    for (const wx of [-48, 51]) {
      ctx.fillStyle = '#09111b'; ellipsePath(ctx, wx, -6, 11, 11); ctx.fill();
      ctx.strokeStyle = '#7d9aa6'; ctx.lineWidth = 2; ellipsePath(ctx, wx, -6, 6.5, 6.5); ctx.stroke();
      ctx.strokeStyle = '#e0f6ff'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) {
        const a = t * 22 + i * Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(wx, -6); ctx.lineTo(wx + Math.cos(a) * 5.5, -6 + Math.sin(a) * 5.5); ctx.stroke();
      }
    }
    ctx.strokeStyle = '#d2fbff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(63, -27); ctx.lineTo(73, -23); ctx.stroke();
    ctx.strokeStyle = '#ff6379'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-72, -24); ctx.lineTo(-64, -23); ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- 单位
  function drawUnit(ctx, ent, opt) {
    if (!ent) return;
    if (ent.isDecoy) {
      if (!ent.alive) return;
      const p = project(ent.x, ent.z, 0);
      ctx.save(); ctx.translate(p.sx, p.sy);
      ctx.fillStyle = '#27334b'; ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
      ctx.fillRect(-24, -74, 48, 74); ctx.strokeRect(-24, -74, 48, 74);
      ctx.fillStyle = '#0c1423';
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) ctx.fillRect(-17 + col * 13, -64 + row * 17, 8, 10);
      ctx.fillStyle = '#ffd166'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('空楼', 0, -84);
      ctx.fillStyle = '#161b27'; ctx.fillRect(-24, 6, 48, 4);
      ctx.fillStyle = '#ffd166'; ctx.fillRect(-24, 6, 48 * Math.max(0, ent.hp / ent.maxHp), 4);
      ctx.restore(); return;
    }
    const o = opt || {};
    const t = (o.t === undefined ? 0 : o.t);
    if (ent.su7 && ent.alive !== false) {
      drawSu7(ctx, ent, o);
      if (o.showBars !== false) drawBars(ctx, ent, o);
      drawMarked(ctx, ent, o); drawStacks(ctx, ent, o); drawBuffs(ctx, ent, o);
      return;
    }
    const key = spriteKey(ent);
    const A = CC.assets;
    let img = A && A.texture ? A.texture(key) : null;
    let usingPlaceholder = false;
    if (!img && A && A.placeholder) {
      img = A.placeholder(key);
      usingPlaceholder = !!(img && img.width);
    }
    const p = poseOf(ent, t, o);
    const s = spriteSize(ent, { scale: o.scale });
    const pt = project(ent.x, ent.z, (ent.h || 0));
    const facing = (ent.facing === -1 ? -1 : 1);
    const alpha = clamp(p.alpha, 0, 1);
    if (alpha <= 0.015) return;

    ctx.save();
    ctx.translate(pt.sx, pt.sy + p.bobY);
    if (ctx.rotate && p.rot) ctx.rotate(p.rot);
    if (ctx.scale) {
      ctx.scale(facing * p.sqx, p.sqy);
    }
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;

    // 闪白/无敌描边光
    const flashAmt = clamp(p.flash + (o.flash || 0), 0, 1);
    if (img && img.width) {
      drawTrimmed(ctx, img, key, -s.w / 2 + facing * p.fwd, -s.h, s.w, s.h);
    } else if (A && A.placeholder) {
      const ph = A.placeholder(key);
      if (ph) ctx.drawImage(ph, -s.w / 2 + facing * p.fwd, -s.h, s.w, s.h);
      else {
        // 连 Canvas 都没有：纯矢量占位块
        ctx.fillStyle = '#7fe3ff';
        ctx.fillRect(-s.w / 2 + facing * p.fwd, -s.h, s.w, s.h);
        if (ctx.fillText) {
          ctx.fillStyle = '#04121c';
          ctx.font = 'bold 20px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String((unitOf(ent).name || '?')).slice(0, 1), 0, -s.h * 0.4);
        }
      }
    }
    if (flashAmt > 0.02 && 'globalCompositeOperation' in ctx) {
      const fv = A && A.flash ? A.flash(key) : null;
      const prev = ctx.globalAlpha;
      ctx.globalCompositeOperation = 'lighter';
      if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha * flashAmt * 0.75;
      if (fv) ctx.drawImage(fv, -s.w / 2 + facing * p.fwd, -s.h, s.w, s.h);
      else {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * flashAmt).toFixed(3) + ')';
        ctx.fillRect(-s.w / 2 + facing * p.fwd, -s.h, s.w, s.h);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = prev;
    }

    // 盾环 / 霸体 / 隐身
    const buffs = ent.buffs || [];
    const hasShield = (ent.shield > 0) || buffs.some(function (b) { return b && b.kind === 'shield'; });
    const hasInvuln = buffs.some(function (b) { return b && b.kind === 'invuln'; });
    const hasSuper = buffs.some(function (b) { return b && b.kind === 'superArmor'; });
    if (hasShield || hasInvuln || hasSuper) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 6);
      ctx.strokeStyle = hasInvuln ? 'rgba(255,240,160,' + (0.5 + 0.4 * pulse).toFixed(2) + ')'
        : hasSuper ? 'rgba(255,170,90,' + (0.4 + 0.3 * pulse).toFixed(2) + ')'
          : 'rgba(120,230,255,' + (0.4 + 0.3 * pulse).toFixed(2) + ')';
      ctx.lineWidth = 2.5;
      ellipsePath(ctx, 0, -s.h * 0.55, s.w * 0.62, s.h * 0.6);
      if (ctx.stroke) ctx.stroke();
    }
    ctx.restore();

    if (o.showBars !== false) drawBars(ctx, ent, o);
    drawCharge(ctx, ent, o);
    drawMarked(ctx, ent, o);
    drawStacks(ctx, ent, o);
    drawBuffs(ctx, ent, o);
    const ground = project(ent.x, ent.z, ent.h || 0);
    if (ent.run || (ent.dash && ent.dash.step.finish) || (ent.stacks && ent.stacks.paceBoost)) {
      const pace = (ent.stacks && ent.stacks.pace) || 0;
      const label = ent.run ? '跑圈 ' + Math.round(ent.run.t / ent.run.step.dur * 100) + '% · 配速 ' + pace + '/5'
        : ent.dash && ent.dash.step.finish ? '终点冲刺 · 配速 ' + pace + '/5' : '补给就绪 · 配速 +2';
      ctx.save(); ctx.fillStyle = 'rgba(6,36,24,0.95)'; rr(ctx, ground.sx - 89, ground.sy - s.h - 48, 178, 24, 6); ctx.fill();
      ctx.fillStyle = '#8dffb9'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, ground.sx, ground.sy - s.h - 32); ctx.restore();
    }
    const bubble = (ent.buffs || []).find((b) => b.kind === 'bubble' && b.t < b.dur);
    if (bubble || ent.bubbleCageT > 0) {
      ctx.save(); ctx.strokeStyle = '#b3edff'; ctx.lineWidth = 2;
      if (ent.bubbleCageT > 0) {
        ctx.fillStyle = 'rgba(115,210,255,0.2)';
        ellipsePath(ctx, ground.sx, ground.sy - s.h * 0.45, s.w * 0.72 + 10, s.h * 0.7); ctx.fill(); ctx.stroke();
      }
      for (let i = 0; i < (bubble ? bubble.mag : 0); i++) {
        const x = ground.sx + (i - 1) * 16;
        ctx.fillStyle = 'rgba(110,210,255,0.4)'; ellipsePath(ctx, x, ground.sy - s.h - 17, 7, 7); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 单个单位的整体屏幕信息（UI/命中数字用）
  function unitScreen(ent, opt) {
    const s = spriteSize(ent, opt || {});
    const p = project(ent.x, ent.z, (ent.h || 0));
    return { x: p.sx, y: p.sy, w: s.w, h: s.h, top: p.sy - s.h, cx: p.sx, cy: p.sy - s.h / 2 };
  }

  CC.sprites = {
    VIEW: VIEW,
    project: project,
    drawUnit: drawUnit,
    drawShadow: drawShadow,
    depthSort: depthSort,
    // 附加：渲染层复用
    scaleX: scaleX,
    scaleZ: scaleZ,
    setCamera: setCamera,
    centerCamera: centerCamera,
    followCamera: followCamera,
    setShake: setShake,
    camera: camera,
    spriteKey: spriteKey,
    spriteSize: spriteSize,
    unitScreen: unitScreen,
    drawSprite: drawSprite,
    drawBars: drawBars,
    drawBuffs: drawBuffs,
    drawStacks: drawStacks,
    drawMarked: drawMarked,
    drawCharge: drawCharge,
    drawChargeWarn: drawChargeWarn,
    drawPickup: drawPickup,
    drawStone: drawStone,
    corpseK: corpseK,
    corpseDur: corpseDur,
    drawTrimmed: drawTrimmed,
    roundRect: rr,
    ellipsePath: ellipsePath,
    poseOf: poseOf,
  };
})();
