// ============================================================
// Web Draw — 网页绘画 content script (v0.3.0)
// 在任意网页之上画画/标注:五种笔刷、图形、文字、橡皮擦、自动保存、导出截图。
// 草稿锚定在"页面坐标",静态画布在文档流中随网页原生滚动 → 滚动零错位。
//
// 架构(单个 IIFE,内部按命名空间模块划分):
//   Coord     坐标换算(页面坐标 <-> 视口坐标)
//   Store     笔迹数据 + 快照式历史(撤销可回退任何操作,含橡皮擦)
//   Renderer  双 canvas 渲染(全页静态层 + 视口实时层)
//   Input     指针分流(按 tool 路由:笔刷/图形/橡皮/文字),document capture
//   Editor    文字工具的内联输入框
//   Persist   草稿自动保存/恢复(localStorage,按 URL 分键)
//   Export    导出全页截图(合成优先,失败退纯草稿)
//   Toolbar   浮动工具栏(工具格/样式/操作/设置)
//   App       状态机与装配;window.__dwInstance 幂等开关
// ============================================================
(function () {
  'use strict';

  // ── 常量 ───────────────────────────────────────────────────
  const Z_INDEX = 2147483647;
  const MAX_STROKES = 2000;
  const MAX_POINTS = 5000;
  const MIN_DIST = 1.2;
  const MAX_HISTORY = 100;
  const SWATCHES = ['#ff3b30', '#ffa400', '#ffe10a', '#1fcecb', '#2f7bff', '#1c1c1c'];
  const SHORTCUT_LIST = [
    ['V', '框选(套索/矩形)'], ['B', '循环切换笔刷'], ['E', '橡皮'], ['T', '文字'],
    ['L', '直线'], ['A', '箭头'], ['R', '矩形'], ['O', '椭圆'],
    ['H', '隐藏 / 显示草稿'], ['Delete', '删除所选'], ['Ctrl+Z', '撤销'], ['Ctrl+S', '导出截图'],
    ['[', '尺寸减小'], [']', '尺寸增大'], ['?', '快捷键面板'], ['Esc', '取消 / 退出'],
  ];
  const MAX_CANVAS_AREA = 24 * 1024 * 1024;
  const MAX_CANVAS_DIM = 32767;

  // 工具分组
  const BRUSH_TOOLS = ['pen', 'marker', 'highlighter', 'pencil', 'neon'];
  const SHAPE_TOOLS = ['line', 'arrow', 'rect', 'ellipse'];
  const TOOL_ORDER = ['select', ...BRUSH_TOOLS, ...SHAPE_TOOLS, 'text', 'eraser'];
  const IS_BRUSH = (t) => BRUSH_TOOLS.includes(t);
  const IS_SHAPE = (t) => SHAPE_TOOLS.includes(t);

  const TOOL_DEFS = {
    pen:        { name: '钢笔',   icon: '✒️', shortcut: 'B', wMin: 1, wMax: 40 },
    marker:     { name: '马克笔', icon: '🖊️', shortcut: '',  wMin: 1, wMax: 40 },
    highlighter:{ name: '荧光笔', icon: '🖍️', shortcut: '',  wMin: 5, wMax: 80 },
    pencil:     { name: '铅笔',   icon: '✏️', shortcut: '',  wMin: 1, wMax: 40 },
    neon:       { name: '霓虹',   icon: '⚡',  shortcut: '',  wMin: 1, wMax: 40 },
    line:       { name: '直线',   icon: '╱',  shortcut: 'L', wMin: 1, wMax: 30 },
    arrow:      { name: '箭头',   icon: '➡️', shortcut: 'A', wMin: 1, wMax: 30 },
    rect:       { name: '矩形',   icon: '▭',  shortcut: 'R', wMin: 1, wMax: 30 },
    ellipse:    { name: '椭圆',   icon: '◯',  shortcut: 'O', wMin: 1, wMax: 30 },
    select:     { name: '选择',   icon: '↖',  shortcut: 'V', wMin: 1, wMax: 40 },
    text:       { name: '文字',   icon: '🆃', shortcut: 'T', wMin: 10, wMax: 72 },
    eraser:     { name: '橡皮',   icon: '🧽', shortcut: 'E', wMin: 5, wMax: 60 },
  };
  const SIZE_LABELS = { pen: '粗细', marker: '粗细', highlighter: '粗细', pencil: '粗细', neon: '粗细', line: '线宽', arrow: '线宽', rect: '线宽', ellipse: '线宽', select: '—', text: '字号', eraser: '橡皮大小' };

  // 可通过 window.DW_CONFIG 覆盖(dev-test.html 用)
  const SETTINGS = Object.assign(
    {
      color: '#ff3b30', width: 4, drawWithMouse: false,
      tool: 'pen', opacity: 1,
      pressureExp: 0.7, pressureMin: 0.15,
      autoSave: true, showDrafts: true,
      selectMode: 'lasso',
    },
    window.DW_CONFIG || {}
  );

  // ── 工具函数 ───────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }

  function computeEffDpr(w, h, dpr) {
    let eff = dpr;
    if (w * eff > MAX_CANVAS_DIM) eff = MAX_CANVAS_DIM / w;
    if (h * eff > MAX_CANVAS_DIM) eff = Math.min(eff, MAX_CANVAS_DIM / h);
    const area = (w * eff) * (h * eff);
    if (area > MAX_CANVAS_AREA) eff = Math.sqrt(MAX_CANVAS_AREA / (w * h));
    return Math.max(0.25, Math.min(dpr, eff));
  }

  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  // 几何工具
  function distPointToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Coord.dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Coord.dist(p, { x: cx, y: cy });
  }
  function distToPath(p, path) {
    if (!path.length) return Infinity;
    if (path.length === 1) return Coord.dist(p, path[0]);
    let m = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const d = distPointToSegment(p, path[i], path[i + 1]);
      if (d < m) m = d;
    }
    return m;
  }
  function bboxOfPoints(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  function bboxIntersects(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  function pointInRect(p, r) {
    return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  }
  function segsIntersect(p1, p2, p3, p4) {
    const o1 = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
    const o2 = (p2.x - p1.x) * (p4.y - p1.y) - (p2.y - p1.y) * (p4.x - p1.x);
    const o3 = (p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x);
    const o4 = (p4.x - p3.x) * (p2.y - p3.y) - (p4.y - p3.y) * (p2.x - p3.x);
    return o1 * o2 < 0 && o3 * o4 < 0;
  }
  function segIntersectsRect(p1, p2, r) {
    if (pointInRect(p1, r) || pointInRect(p2, r)) return true;
    const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    for (let i = 0; i < 4; i++) {
      if (segsIntersect(p1, p2, c[i], c[(i + 1) % 4])) return true;
    }
    return false;
  }
  // 一笔的"采样点"(文字取文字框四角,图形取角点,笔刷取全部点)
  function strokeHitPoints(stroke) {
    const tool = stroke.tool || 'pen';
    if (tool === 'text') {
      const p = stroke.points[0];
      const w = String(stroke.text || '').length * stroke.fontSize * 0.6;
      const h = stroke.fontSize;
      return [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }];
    }
    if (IS_SHAPE(tool)) {
      const a = stroke.points[0], b = stroke.points[stroke.points.length - 1];
      if (tool === 'line' || tool === 'arrow') return [a, b];
      return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    return stroke.points;
  }
  // 判定一笔是否落在选择框内(点在内 / 线段穿过)
  function rectHitsStroke(r, stroke) {
    const pts = strokeHitPoints(stroke);
    for (let i = 0; i < pts.length; i++) {
      if (pointInRect(pts[i], r)) return true;
      if (i && segIntersectsRect(pts[i - 1], pts[i], r)) return true;
    }
    return false;
  }

  // ── 区域裁剪几何(框选/套索共用) ──────────────────────────
  function lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function segSegIntersectT(a, b, c, d) {
    const d1x = b.x - a.x, d1y = b.y - a.y;
    const d2x = d.x - c.x, d2y = d.y - c.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((c.x - a.x) * d2y - (c.y - a.y) * d2x) / denom;
    const u = ((c.x - a.x) * d1y - (c.y - a.y) * d1x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t: t, u: u };
  }
  // 线段在矩形内的参数区间(Liang-Barsky)
  function clipSegmentRectT(a, b, r) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - r.x0, r.x1 - a.x, a.y - r.y0, r.y1 - a.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return []; }
      else {
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return []; if (t > t0) t0 = t; }
        else { if (t < t0) return []; if (t < t1) t1 = t; }
      }
    }
    if (t0 > t1) return [];
    return [[t0, t1]];
  }
  // 线段在多边形内的参数区间(按边求交 + 中点判内)
  function clipSegmentPolyT(a, b, poly) {
    const ts = [];
    for (let i = 0; i < poly.length; i++) {
      const it = segSegIntersectT(a, b, poly[i], poly[(i + 1) % poly.length]);
      if (it && it.t > 0 && it.t < 1) ts.push(it.t);
    }
    ts.sort((x, y) => x - y);
    const uniq = [];
    for (const t of ts) if (!uniq.length || Math.abs(t - uniq[uniq.length - 1]) > 1e-6) uniq.push(t);
    const pts = [0, ...uniq, 1];
    const ranges = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const m0 = pts[i], m1 = pts[i + 1];
      if (m1 - m0 < 1e-6) continue;
      if (pointInPolygon(lerp(a, b, (m0 + m1) / 2), poly)) ranges.push([m0, m1]);
    }
    const merged = [];
    for (const r of ranges) {
      if (merged.length && r[0] - merged[merged.length - 1][1] < 1e-6) merged[merged.length - 1][1] = r[1];
      else merged.push(r.slice());
    }
    return merged;
  }
  function pointInRegion(p, region) {
    return region.type === 'rect' ? pointInRect(p, region.r) : pointInPolygon(p, region.pts);
  }
  function clipSegmentRegionT(a, b, region) {
    return region.type === 'rect' ? clipSegmentRectT(a, b, region.r) : clipSegmentPolyT(a, b, region.pts);
  }
  // 折线按区域切分为"区域内/区域外"的连续片段(带边界插值点)
  function splitPolyline(points, region) {
    if (!points.length) return { inside: [], outside: [] };
    if (points.length === 1) {
      return pointInRegion(points[0], region)
        ? { inside: [points], outside: [] }
        : { inside: [], outside: [points] };
    }
    const runsIn = [], runsOut = [];
    let curRun = null, curType = null;
    const emit = (type, pt) => {
      if (curType !== type) {
        if (curRun && curRun.length) (curType ? runsIn : runsOut).push(curRun);
        curRun = [];
        curType = type;
      }
      const last = curRun[curRun.length - 1];
      if (!last || Math.abs(last.x - pt.x) + Math.abs(last.y - pt.y) > 0.01) curRun.push(pt);
    };
    const flush = () => {
      if (curRun && curRun.length) (curType ? runsIn : runsOut).push(curRun);
      curRun = null;
      curType = null;
    };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const ranges = clipSegmentRegionT(a, b, region);
      if (!ranges.length) {
        emit(false, a);
        continue;
      }
      let cursor = 0;
      for (const [t0, t1] of ranges) {
        if (t0 > cursor) emit(false, lerp(a, b, cursor));
        emit(true, lerp(a, b, Math.max(cursor, t0)));
        emit(true, lerp(a, b, t1));
        cursor = t1;
      }
      if (cursor < 1) emit(false, lerp(a, b, cursor));
    }
    flush();
    return { inside: runsIn, outside: runsOut };
  }
  // 一笔 → "选内片段" 与 "选外片段"
  function fragmentsForStroke(stroke, region) {
    const tool = stroke.tool || 'pen';
    if (tool === 'text' || tool === 'rect' || tool === 'ellipse') {
      const hit = strokeHitPoints(stroke).some((p) => pointInRegion(p, region));
      const whole = Object.assign({}, stroke, { srcId: stroke.id, id: ++Input._uid, points: stroke.points.slice() });
      return hit ? { inside: [whole], outside: [] } : { inside: [], outside: [whole] };
    }
    const sp = splitPolyline(stroke.points, region);
    return {
      inside: sp.inside.map((run) => Object.assign({}, stroke, { srcId: stroke.id, id: ++Input._uid, points: run })),
      outside: sp.outside.map((run) => Object.assign({}, stroke, { srcId: stroke.id, id: ++Input._uid, points: run })),
    };
  }

  // ── 坐标换算 ───────────────────────────────────────────────
  const Coord = {
    toPage(ev) { return { x: ev.clientX + window.scrollX, y: ev.clientY + window.scrollY }; },
    dist(a, b) {
      const dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    },
  };

  // ── 数据层(快照式历史) ─────────────────────────────────────
  const Store = {
    strokes: [],
    history: [],
    onChange: null,               // Persist 订阅:任何变更后触发保存

    commitChange(before, after) {
      if (after.length > MAX_STROKES) {           // 笔迹总量上限,丢弃最旧
        const drop = after.length - MAX_STROKES;
        after = after.slice(drop);
        before = before.slice(Math.max(0, before.length - MAX_STROKES));
      }
      this.history.push({ before: before, after: after });
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.strokes = after;
      if (this.onChange) this.onChange();
    },
    undo() {
      if (!this.history.length) return false;
      const op = this.history.pop();
      this.strokes = op.before;
      if (this.onChange) this.onChange();
      return true;
    },
    clear() {
      if (!this.strokes.length) return false;
      this.commitChange(this.strokes, []);
      return true;
    },
    canUndo() { return this.history.length > 0; },
  };

  // ── 压感与线条 ─────────────────────────────────────────────
  function normPressure(p) { return Math.pow(clamp(p, 0, 1), SETTINGS.pressureExp); }

  // 笔刷类线宽(按工具定宽,荧光笔恒定无压感)
  function brushWidthFor(stroke, pt) {
    const tool = stroke.tool || 'pen';
    const p = tool === 'highlighter' ? 1 : normPressure(pt.p);
    let base = stroke.width;
    if (tool === 'marker') base *= 1.5;
    else if (tool === 'pencil') base *= 0.7;
    else if (tool === 'highlighter') base *= 3;
    const min = tool === 'highlighter' ? 0.8 : SETTINGS.pressureMin;
    return base * (min + (1 - min) * p);
  }

  function smoothStroke(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      out.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4, p: (a.p + 2 * b.p + c.p) / 4 });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function drawArrowHead(ctx, a, b, width) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 8 + width;
    const hw = 4 + width * 0.6;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-len, -hw);
    ctx.lineTo(-len, hw);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawPolyline(ctx, pts, stroke, mult, alphaMult) {
    const outer = ctx.globalAlpha;
    ctx.globalAlpha = outer * alphaMult;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = (brushWidthFor(stroke, a) + brushWidthFor(stroke, b)) / 2 * mult;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = outer;
  }

  // 核心渲染:按 tool 分支
  function drawStroke(ctx, stroke) {
    if (!stroke) return;
    const tool = stroke.tool || 'pen';
    const alpha = (typeof stroke.opacity === 'number' ? stroke.opacity : 1) * (tool === 'highlighter' ? 0.5 : 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = stroke.color;
    ctx.strokeStyle = stroke.color;

    // 文字
    if (tool === 'text') {
      const pt = stroke.points && stroke.points[0];
      if (pt && stroke.text) {
        ctx.font = 'normal ' + stroke.fontSize + 'px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        const lines = String(stroke.text).split('\n');
        const lh = stroke.fontSize * 1.3;
        lines.forEach((ln, i) => ctx.fillText(ln, pt.x, pt.y + stroke.fontSize + i * lh));
      }
      ctx.restore();
      return;
    }

    const pts = stroke.points;
    if (!pts || !pts.length) { ctx.restore(); return; }

    // 图形(两点)
    if (IS_SHAPE(tool)) {
      const a = pts[0], b = pts[pts.length - 1];
      if (!a || !b) { ctx.restore(); return; }
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (tool === 'line') {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (tool === 'arrow') {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        drawArrowHead(ctx, a, b, stroke.width);
      } else if (tool === 'rect') {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (tool === 'ellipse') {
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // 笔刷
    const smoothed = smoothStroke(pts);
    ctx.lineJoin = 'round';
    ctx.lineCap = (tool === 'marker' || tool === 'highlighter') ? 'butt' : 'round';
    if (smoothed.length === 1) {
      const r = brushWidthFor(stroke, smoothed[0]) / 2;
      ctx.beginPath();
      ctx.arc(smoothed[0].x, smoothed[0].y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (tool === 'neon') {
      drawPolyline(ctx, smoothed, stroke, 2.2, 0.25);
      drawPolyline(ctx, smoothed, stroke, 1.4, 0.5);
      drawPolyline(ctx, smoothed, stroke, 1, 1);
    } else {
      drawPolyline(ctx, smoothed, stroke, 1, 1);
    }
    ctx.restore();
  }

  // ── 橡皮擦(段级) ───────────────────────────────────────────
  function eraserRadius() { return Math.max(4, SETTINGS.width / 2); }

  // 对 Store.strokes 应用擦除,返回 {strokes, changed}
  function eraseStrokes(strokes, path, radius) {
    if (!path.length) return { strokes: strokes, changed: false };
    const erBBox = bboxOfPoints(path);
    const out = [];
    let changed = false;

    for (const st of strokes) {
      const tool = st.tool || 'pen';

      // 文字:锚点命中即整条删除
      if (tool === 'text') {
        if (distToPath(st.points[0], path) <= radius) { changed = true; continue; }
        out.push(st);
        continue;
      }

      // 图形:关键点命中即整条删除
      if (IS_SHAPE(tool)) {
        const a = st.points[0], b = st.points[st.points.length - 1];
        const keyPts = (tool === 'line' || tool === 'arrow')
          ? [a, b]
          : [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
        let hit = false;
        for (const p of keyPts) { if (distToPath(p, path) <= radius) { hit = true; break; } }
        if (hit) { changed = true; continue; }
        out.push(st);
        continue;
      }

      // 笔刷:bbox 粗筛
      const stBBox = bboxOfPoints(st.points);
      if (!bboxIntersects(stBBox, erBBox)) { out.push(st); continue; }

      // 逐点判定:点距橡皮路径 < r,或橡皮点落在某线段附近
      const hits = new Array(st.points.length).fill(false);
      for (let i = 0; i < st.points.length; i++) {
        if (distToPath(st.points[i], path) <= radius) hits[i] = true;
      }
      for (const ep of path) {
        for (let i = 0; i < st.points.length - 1; i++) {
          if (distPointToSegment(ep, st.points[i], st.points[i + 1]) <= radius) { hits[i] = true; hits[i + 1] = true; }
        }
      }
      if (!hits.some(Boolean)) { out.push(st); continue; }
      if (hits.every(Boolean)) { changed = true; continue; }   // 整条被擦
      changed = true;
      let run = [];
      for (let i = 0; i < st.points.length; i++) {
        if (!hits[i]) run.push(st.points[i]);
        else if (run.length) {
          out.push(makeSubStroke(st, run));
          run = [];
        }
      }
      if (run.length) out.push(makeSubStroke(st, run));
    }
    return { strokes: out, changed: changed };
  }

  function makeSubStroke(st, pts) {
    return Object.assign({}, st, { id: ++Input._uid, points: pts });
  }

  // ── 渲染器(双 canvas) ─────────────────────────────────────
  const Renderer = {
    canvas: null, staticCanvas: null, ctx: null, staticCtx: null,
    _size: { w: 0, h: 0, dpr: 1, eff: 1 },
    liveRaf: 0, eraseRaf: 0,

    init() {
      this.staticCanvas = document.createElement('canvas');
      this.staticCanvas.id = 'dw-static-canvas';
      this.staticCtx = this.staticCanvas.getContext('2d');
      Object.assign(this.staticCanvas.style, {
        position: 'absolute', left: '0', top: '0',
        pointerEvents: 'none', zIndex: String(Z_INDEX - 1),
      });
      (document.body || document.documentElement).appendChild(this.staticCanvas);

      this.canvas = document.createElement('canvas');
      this.canvas.id = 'dw-canvas';
      this.ctx = this.canvas.getContext('2d');
      Object.assign(this.canvas.style, {
        position: 'fixed', left: '0', top: '0',
        pointerEvents: 'none', zIndex: String(Z_INDEX - 1),
      });
      root.appendChild(this.canvas);

      this._hScroll = () => { if (Input.activePointers.size) this.requestLive(); };
      this._hResize = () => { this._checkSize(); this.presentLive(); };
      this._hVV = () => this.presentLive();
      window.addEventListener('scroll', this._hScroll, { passive: true });
      window.addEventListener('resize', this._hResize, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this._hVV);
        window.visualViewport.addEventListener('scroll', this._hVV);
      }

      this._checkSize();
      this._sizeTimer = setInterval(() => this._checkSize(), 500);
      this.presentLive();
    },

    destroy() {
      clearInterval(this._sizeTimer);
      window.removeEventListener('scroll', this._hScroll);
      window.removeEventListener('resize', this._hResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this._hVV);
        window.visualViewport.removeEventListener('scroll', this._hVV);
      }
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      if (this.staticCanvas && this.staticCanvas.parentNode) this.staticCanvas.parentNode.removeChild(this.staticCanvas);
      this.canvas = null;
      this.staticCanvas = null;
    },

    _measure() {
      const se = document.scrollingElement || document.documentElement;
      return {
        w: Math.max(se.scrollWidth, window.innerWidth),
        h: Math.max(se.scrollHeight, window.innerHeight),
        dpr: window.devicePixelRatio || 1,
      };
    },

    _checkSize() {
      if (!this.staticCanvas) return;
      const m = this._measure();
      const eff = computeEffDpr(m.w, m.h, m.dpr);
      const s = this._size;
      if (s.w !== m.w || s.h !== m.h || s.dpr !== m.dpr || s.eff !== eff) {
        this._size = { w: m.w, h: m.h, dpr: m.dpr, eff: eff };
        this._syncStatic();
      }
    },

    _syncStatic() {
      const s = this._size;
      const bw = Math.max(1, Math.round(s.w * s.eff));
      const bh = Math.max(1, Math.round(s.h * s.eff));
      if (this.staticCanvas.width !== bw) this.staticCanvas.width = bw;
      if (this.staticCanvas.height !== bh) this.staticCanvas.height = bh;
      this.staticCanvas.style.width = s.w + 'px';
      this.staticCanvas.style.height = s.h + 'px';
      this.redrawStatic();
    },

    redrawStaticWith(strokes) {
      if (!this.staticCanvas) return;
      const s = this._size;
      const ctx = this.staticCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
      ctx.restore();
      ctx.setTransform(s.eff, 0, 0, s.eff, 0, 0);
      if (SETTINGS.showDrafts) for (const st of strokes) drawStroke(ctx, st);
    },

    redrawStatic() { this.redrawStaticWith(Store.strokes); },

    presentLive() {
      if (!this.canvas) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.round(vw * dpr));
      const bh = Math.max(1, Math.round(vh * dpr));
      if (this.canvas.width !== bw) this.canvas.width = bw;
      if (this.canvas.height !== bh) this.canvas.height = bh;
      this.canvas.style.width = vw + 'px';
      this.canvas.style.height = vh + 'px';

      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr);

      for (const [, s] of Input.activePointers) {
        if (s.mode === 'eraser') {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = '#666';
          for (const p of s.points) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, s.radius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        } else if (!s.mode && SETTINGS.showDrafts) {
          drawStroke(ctx, s);
        }
      }

      Selection.render(ctx);   // 选框 / 选中框 / 移动预览
    },

    requestLive() {
      if (this.liveRaf) return;
      this.liveRaf = requestAnimationFrame(() => {
        this.liveRaf = 0;
        this.presentLive();
      });
    },

    requestErasePreview() {
      if (this.eraseRaf) return;
      this.eraseRaf = requestAnimationFrame(() => {
        this.eraseRaf = 0;
        const erasers = [...Input.activePointers.values()].filter((s) => s.mode === 'eraser');
        if (!erasers.length) { this.presentLive(); return; }
        const path = [];
        let radius = 0;
        for (const er of erasers) {
          for (const p of er.points) path.push(p);
          if (er.radius > radius) radius = er.radius;
        }
        const preview = eraseStrokes(Store.strokes, path, radius);
        this.redrawStaticWith(preview.strokes);
        this.presentLive();
      });
    },

    // 提交完成的笔画:入历史 + 增量画进静态层
    commitStroke(stroke) {
      Store.commitChange(Store.strokes, Store.strokes.concat([stroke]));
      const ctx = this.staticCtx;
      if (ctx) {
        ctx.setTransform(this._size.eff, 0, 0, this._size.eff, 0, 0);
        drawStroke(ctx, stroke);
      }
      this.presentLive();
    },
  };

  // ── 输入分流(document capture) ─────────────────────────────
  const Input = {
    activePointers: new Map(),
    _uid: 0,
    _lockCount: 0,

    init() {
      this._hDown = (e) => this.onDown(e);
      this._hMove = (e) => this.onMove(e);
      this._hUp = (e) => this.onUp(e);
      this._hCancel = (e) => this.onCancel(e);
      document.addEventListener('pointerdown', this._hDown, true);
      document.addEventListener('pointermove', this._hMove, true);
      document.addEventListener('pointerup', this._hUp, true);
      document.addEventListener('pointercancel', this._hCancel, true);
    },

    destroy() {
      document.removeEventListener('pointerdown', this._hDown, true);
      document.removeEventListener('pointermove', this._hMove, true);
      document.removeEventListener('pointerup', this._hUp, true);
      document.removeEventListener('pointercancel', this._hCancel, true);
      this._lockCount = 0;
      document.documentElement.removeAttribute('data-dw-lock');
      this.activePointers.clear();
    },

    isToolbarTarget(t) { return !!(t && t.closest && t.closest('#draw-root')); },

    _isDrawPointer(e) {
      const t = e.pointerType;
      return t === 'pen' || t === 'eraser' || (t === 'mouse' && SETTINGS.drawWithMouse);
    },

    onDown(e) {
      if (this.isToolbarTarget(e.target)) return;   // 工具栏自处理
      Editor.commit();                              // 先落定正在输入的文字
      if (!this._isDrawPointer(e)) return;          // touch / mouse(放行)
      if (!(e.buttons & 1)) return;

      const tool = SETTINGS.tool;
      e.preventDefault();
      if (tool === 'text') {
        if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.lockPen();
        Editor.open(e.clientX, e.clientY);
        if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
        return;
      }
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.lockPen();

      if (tool === 'select') {
        this.activePointers.set(e.pointerId, { mode: 'select' });
        Selection.onDown(Coord.toPage(e));
        Renderer.requestLive();
        return;
      }

      if (tool === 'eraser') {
        this.activePointers.set(e.pointerId, {
          mode: 'eraser',
          points: [Coord.toPage(e)],
          radius: eraserRadius(),
          penLocked: e.pointerType === 'pen' || e.pointerType === 'eraser',
        });
        Renderer.requestLive();
        return;
      }

      const st = {
        id: ++this._uid,
        tool: tool,
        color: SETTINGS.color,
        width: SETTINGS.width,
        opacity: SETTINGS.opacity,
        pointerType: e.pointerType,
        points: [pointFromEvent(e)],
      };
      if (IS_SHAPE(tool)) st.points.push(pointFromEvent(e));   // 图形第二点,后续 move 覆盖
      this.activePointers.set(e.pointerId, st);
      Renderer.requestLive();
    },

    onMove(e) {
      const st = this.activePointers.get(e.pointerId);
      if (!st) return;

      // 框选
      if (st.mode === 'select') {
        if (!(e.buttons & 1)) { this.endStroke(e.pointerId); return; }
        e.preventDefault();
        Selection.onMove(Coord.toPage(e));
        Renderer.requestLive();
        return;
      }

      // 橡皮擦
      if (st.mode === 'eraser') {
        if (!(e.buttons & 1)) { this.endStroke(e.pointerId); if (st.penLocked) this.unlockPen(); return; }
        const samples = (e.getCoalescedEvents && e.pointerType === 'pen') ? e.getCoalescedEvents() : [e];
        for (const s of samples) {
          if (!(s.buttons & 1)) continue;
          const pt = Coord.toPage(s);
          const last = st.points[st.points.length - 1];
          if (last && Coord.dist(pt, last) < MIN_DIST) continue;
          st.points.push(pt);
        }
        e.preventDefault();
        Renderer.requestErasePreview();
        return;
      }

      // 图形:只更新终点
      if (IS_SHAPE(st.tool)) {
        if (!(e.buttons & 1)) { this.endStroke(e.pointerId); return; }
        st.points[1] = pointFromEvent(e);
        e.preventDefault();
        Renderer.requestLive();
        return;
      }

      // 笔刷:追加采样
      const samples = (e.getCoalescedEvents && e.pointerType === 'pen') ? e.getCoalescedEvents() : [e];
      let hadContact = false;
      for (const s of samples) {
        if (!(s.buttons & 1)) continue;
        hadContact = true;
        const pt = pointFromEvent(s);
        const last = st.points[st.points.length - 1];
        if (last && Coord.dist(pt, last) < MIN_DIST) continue;
        st.points.push(pt);
        if (st.points.length >= MAX_POINTS) break;
      }
      if (hadContact) {
        e.preventDefault();
        Renderer.requestLive();
      } else if (!(e.buttons & 1)) {
        this.endStroke(e.pointerId);
        if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
      }
    },

    onUp(e) {
      this.endStroke(e.pointerId);
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
    },

    onCancel(e) {
      this.endStroke(e.pointerId);
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
    },

    endStroke(pointerId) {
      const st = this.activePointers.get(pointerId);
      this.activePointers.delete(pointerId);
      if (!st) return;

      if (st.mode === 'select') {
        Selection.onUp();
        return;
      }
      if (st.mode === 'eraser') {
        this.finishErase(st);
        return;
      }
      if (IS_SHAPE(st.tool)) {   // 图形没拖出有效第二点 → 丢弃
        if (st.points.length < 2 || Coord.dist(st.points[0], st.points[1]) < 1) {
          Renderer.presentLive();
          return;
        }
      }
      if (st.points.length) Renderer.commitStroke(st);
      else Renderer.requestLive();
    },

    finishErase(eraserSt) {
      if (!eraserSt.points.length) { Renderer.presentLive(); return; }
      const res = eraseStrokes(Store.strokes, eraserSt.points, eraserSt.radius);
      if (res.changed) {
        Store.commitChange(Store.strokes, res.strokes);
        Selection.clear();
      }
      Renderer.redrawStatic();
      Renderer.presentLive();
    },

    lockPen() {
      this._lockCount++;
      document.documentElement.setAttribute('data-dw-lock', '');
    },
    unlockPen() {
      this._lockCount = Math.max(0, this._lockCount - 1);
      if (this._lockCount === 0) document.documentElement.removeAttribute('data-dw-lock');
    },
  };

  function pointFromEvent(ev) {
    const pg = Coord.toPage(ev);
    let p = ev.pointerType === 'mouse' ? 1 : (typeof ev.pressure === 'number' ? ev.pressure : 1);
    if (!(p > 0)) p = 1;
    return { x: pg.x, y: pg.y, p: p, tilt: [ev.tiltX || 0, ev.tiltY || 0] };
  }

  // ── 文字编辑器 ─────────────────────────────────────────────
  const Editor = {
    el: null,
    open(clientX, clientY) {
      this.commit();
      if (this.el) this.cancel();
      this.el = document.createElement('textarea');
      this.el.className = 'dw-text-editor';
      this.el.style.left = clientX + 'px';
      this.el.style.top = clientY + 'px';
      this.el.style.fontSize = SETTINGS.width + 'px';
      this.el.style.color = SETTINGS.color;
      root.appendChild(this.el);
      this.el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
      });
      this.el.addEventListener('blur', () => this.commit());
      this.el.focus();
    },
    commit() {
      if (!this.el) return;
      const text = this.el.value.trim();
      const rect = this.el.getBoundingClientRect();
      const stroke = {
        id: ++Input._uid,
        tool: 'text',
        text: text,
        fontSize: SETTINGS.width,
        color: SETTINGS.color,
        opacity: SETTINGS.opacity,
        pointerType: 'text',
        points: [{ x: rect.left + window.scrollX, y: rect.top + window.scrollY, p: 1, tilt: [0, 0] }],
      };
      if (text) Renderer.commitStroke(stroke);
      else Renderer.presentLive();
      this.cancel();
    },
    cancel() {
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
    },
    get isOpen() { return !!this.el; },
  };

  // ── 持久化(自动保存/恢复) ─────────────────────────────────
  const Persist = {
    key: '',
    timer: 0,
    init() {
      const base = location.origin + location.pathname + location.search;
      this.key = 'dw:drafts:' + hashStr(base);
      Store.onChange = () => this.scheduleSave();
      this.restore();
    },
    restore() {
      try {
        const raw = localStorage.getItem(this.key);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && data.v === 1 && Array.isArray(data.strokes)) {
          for (const s of data.strokes) s.id = ++Input._uid;
          Store.strokes = data.strokes;
          Renderer.redrawStatic();
        }
      } catch (err) { /* 数据损坏 / 无痕模式:忽略 */ }
    },
    scheduleSave() {
      if (!SETTINGS.autoSave) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.save(), 300);
    },
    save() {
      if (!SETTINGS.autoSave) return;
      try {
        localStorage.setItem(this.key, JSON.stringify({ v: 1, strokes: Store.strokes }));
      } catch (err) {
        toast('自动保存失败:本地存储空间不足,已关闭自动保存');
        SETTINGS.autoSave = false;
        Toolbar.syncAutoSave();
      }
    },
    clear() {
      try { localStorage.removeItem(this.key); } catch (err) { /* noop */ }
    },
    destroy() {
      clearTimeout(this.timer);
      Store.onChange = null;
    },
  };

  // ── 导出 ───────────────────────────────────────────────────
  const Export = {
    _busy: false,
    async run() {
      if (this._busy) return;
      this._busy = true;
      Editor.commit();
      try {
        let done = false;
        try { done = await this.composite(); }
        catch (err) {
          console.warn('[WebDraw] 合成导出失败,退回纯草稿:', err);
        }
        if (!done) this.draftOnly();
      } finally {
        this._busy = false;
      }
    },

    filename() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
      const host = (location.hostname || 'page').replace(/[^\w.-]/g, '_');
      return 'webdraw-' + host + '-' + ts + '.png';
    },

    async composite() {
      if (!(await ensureHtml2canvas())) return false;
      const se = document.scrollingElement || document.documentElement;
      const w = Math.max(se.scrollWidth, window.innerWidth);
      const h = Math.max(se.scrollHeight, window.innerHeight);
      const dpr = window.devicePixelRatio || 1;
      const scale = (w * h > 12e6) ? 1 : Math.min(dpr, 2);

      const canvas = await window.html2canvas(document.body, {
        width: w,
        height: h,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        scale: scale,
        backgroundColor: null,
        useCORS: true,
        logging: false,
        onclone: (doc) => {
          const el = doc.getElementById('dw-static-canvas');
          if (el) el.style.display = 'none';
        },
      });

      const ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      if (SETTINGS.showDrafts) for (const s of Store.strokes) drawStroke(ctx, s);
      downloadCanvas(canvas, this.filename());
      return true;
    },

    draftOnly() {
      const se = document.scrollingElement || document.documentElement;
      const w = Math.max(se.scrollWidth, window.innerWidth);
      const h = Math.max(se.scrollHeight, window.innerHeight);
      const eff = computeEffDpr(w, h, window.devicePixelRatio || 1);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * eff));
      c.height = Math.max(1, Math.round(h * eff));
      const ctx = c.getContext('2d');
      ctx.setTransform(eff, 0, 0, eff, 0, 0);
      if (SETTINGS.showDrafts) for (const s of Store.strokes) drawStroke(ctx, s);
      downloadCanvas(c, this.filename());
    },
  };

  function downloadCanvas(canvas, name) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = name;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
  }

  async function ensureHtml2canvas() {
    if (window.html2canvas) return true;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return false;
      const res = await chrome.runtime.sendMessage({ type: 'dw:inject-lib' });
      if (!res || !res.ok) return false;
      await new Promise((r) => setTimeout(r, 50));
      return !!window.html2canvas;
    } catch (err) {
      return false;
    }
  }

  // ── 框选/套索与移动(片段式选择:只选中落在区域内的部分) ────
  const Selection = {
    mode: 'idle',                 // idle | marquee | selected | moving
    region: null,                 // {type:'rect', r} | {type:'poly', pts}
    selectedFragments: [],        // 被选中的片段(裁剪出的子笔迹)
    remainderBySrc: new Map(),    // 源笔画 id → 区域外片段(移动/删除时保留)
    affectedIds: new Set(),       // 受影响的源笔画 id
    moveStart: null,
    moveDelta: { x: 0, y: 0 },
    hasMoved: false,
    bar: null,

    init() {
      this.bar = document.createElement('div');
      this.bar.className = 'dw-selbar';
      this.bar.style.display = 'none';
      this.bar.innerHTML =
        '<span class="dw-selbar-info">已选 <b class="dw-selbar-count">0</b> 段</span>' +
        '<button id="dw-sel-del" title="删除所选 Delete">删除</button>' +
        '<button id="dw-sel-cancel" title="取消选择 Esc">取消</button>';
      this.bar.querySelector('#dw-sel-del').addEventListener('pointerdown', (e) => e.stopPropagation());
      this.bar.querySelector('#dw-sel-del').addEventListener('click', (e) => { e.stopPropagation(); this.deleteSelected(); });
      this.bar.querySelector('#dw-sel-cancel').addEventListener('pointerdown', (e) => e.stopPropagation());
      this.bar.querySelector('#dw-sel-cancel').addEventListener('click', (e) => { e.stopPropagation(); this.clear(); });
      root.appendChild(this.bar);
    },

    destroy() {
      this.clear();
      if (this.bar) {
        this.bar.remove();
        this.bar = null;
      }
    },

    hasSelection() { return this.mode === 'selected' || this.mode === 'moving'; },

    fragmentsBBox(delta) {
      if (!this.selectedFragments.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const f of this.selectedFragments) {
        for (const p of f.points) {
          const x = p.x + (delta ? delta.x : 0), y = p.y + (delta ? delta.y : 0);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (minX === Infinity) return null;
      return { minX: minX - 6, minY: minY - 6, maxX: maxX + 6, maxY: maxY + 6 };
    },

    // 由当前区域重新计算被选片段 + 区域外保留片段
    computeSelection() {
      const insideAll = [];
      const remainder = new Map();
      for (const s of Store.strokes) {
        const { inside, outside } = fragmentsForStroke(s, this.region);
        if (inside.length) {
          insideAll.push(...inside);
          remainder.set(s.id, outside);
        }
      }
      this.selectedFragments = insideAll;
      this.remainderBySrc = remainder;
      this.affectedIds = new Set(remainder.keys());
    },

    onDown(page) {
      if (this.hasSelection()) {
        const bb = this.fragmentsBBox(null);
        if (bb && pointInRect(page, bb)) {   // 点在选中范围内 → 开始移动
          this.mode = 'moving';
          this.moveStart = page;
          this.moveDelta = { x: 0, y: 0 };
          this.hasMoved = false;
          this.hideBar();
          return;
        }
      }
      this.clear();
      this.mode = 'marquee';
      this.region = SETTINGS.selectMode === 'lasso'
        ? { type: 'poly', pts: [page] }
        : { type: 'rect', r: { x0: page.x, y0: page.y, x1: page.x, y1: page.y } };
    },

    onMove(page) {
      if (this.mode === 'marquee' && this.region) {
        if (this.region.type === 'rect') {
          this.region.r.x1 = page.x;
          this.region.r.y1 = page.y;
        } else {
          const pts = this.region.pts;
          const last = pts[pts.length - 1];
          if (!last || Coord.dist(page, last) > 1.5) pts.push(page);
        }
        this.computeSelection();
      } else if (this.mode === 'moving' && this.moveStart) {
        this.moveDelta = { x: page.x - this.moveStart.x, y: page.y - this.moveStart.y };
        if (Math.abs(this.moveDelta.x) + Math.abs(this.moveDelta.y) > 2) {
          this.hasMoved = true;
          Renderer.redrawStaticWith(this.previewStrokes(this.moveDelta));
        }
      }
    },

    onUp() {
      if (this.mode === 'marquee') {
        this.computeSelection();
        let valid = this.selectedFragments.length > 0;
        if (this.region && this.region.type === 'poly' && this.region.pts.length < 3) valid = false;
        if (!valid) {
          this.clear();
        } else {
          this.mode = 'selected';
          this.region = null;
          this.showBar();
          Renderer.presentLive();
        }
      } else if (this.mode === 'moving') {
        this.mode = 'selected';
        if (this.hasMoved) this.commitMove();
        this.showBar();
        Renderer.presentLive();
      }
    },

    // 移动预览:区域外片段留在原位,选内片段按 delta 平移
    previewStrokes(delta) {
      const movedMap = new Map(this.selectedFragments.map((f) => [f.id, translateStroke(f, delta.x, delta.y)]));
      const moved = [...movedMap.values()];
      const before = Store.strokes;
      if (this.remainderBySrc.size) {
        const ids = this.affectedIds;
        const out = [];
        for (const s of before) {
          if (ids.has(s.id)) {
            out.push(...(this.remainderBySrc.get(s.id) || []));
            for (const m of moved) if (m.srcId === s.id) out.push(m);
          } else out.push(s);
        }
        return out;
      }
      return before.map((s) => (movedMap.has(s.id) ? movedMap.get(s.id) : s));
    },

    commitMove() {
      const dx = this.moveDelta.x, dy = this.moveDelta.y;
      if (!dx && !dy) return;
      const movedMap = new Map(this.selectedFragments.map((f) => [f.id, translateStroke(f, dx, dy)]));
      const moved = [...movedMap.values()];
      const before = Store.strokes;
      let after;
      if (this.remainderBySrc.size) {
        const ids = this.affectedIds;
        after = [];
        for (const s of before) {
          if (ids.has(s.id)) {
            after.push(...(this.remainderBySrc.get(s.id) || []));
            for (const m of moved) if (m.srcId === s.id) after.push(m);
          } else after.push(s);
        }
      } else {
        after = before.map((s) => (movedMap.has(s.id) ? movedMap.get(s.id) : s));
      }
      Store.commitChange(before, after);
      this.selectedFragments = moved;
      this.remainderBySrc = new Map();
      this.affectedIds = new Set(moved.map((f) => f.id));
      Renderer.redrawStatic();
      Renderer.presentLive();
    },

    deleteSelected() {
      const before = Store.strokes;
      let after;
      if (this.remainderBySrc.size) {
        // 未移动:源笔画仍在 Store,删除 = 只保留区域外片段
        const ids = this.affectedIds;
        after = [];
        for (const s of before) {
          if (ids.has(s.id)) after.push(...(this.remainderBySrc.get(s.id) || []));
          else after.push(s);
        }
      } else {
        // 已移动:被选片段已在 Store,直接按 id 过滤
        const ids = new Set(this.selectedFragments.map((f) => f.id));
        after = before.filter((s) => !ids.has(s.id));
      }
      if (after.length === before.length) return;
      Store.commitChange(before, after);
      Renderer.redrawStatic();
      this.clear();
    },

    clear() {
      this.mode = 'idle';
      this.region = null;
      this.selectedFragments = [];
      this.remainderBySrc = new Map();
      this.affectedIds = new Set();
      this.moveDelta = { x: 0, y: 0 };
      this.hasMoved = false;
      this.hideBar();
      Renderer.presentLive();
    },

    // 实时层:区域轮廓 + 选中片段高光
    render(ctx) {
      if (this.mode === 'marquee' && this.region) drawRegionOutline(ctx, this.region);
      const delta = this.mode === 'moving' ? this.moveDelta : null;
      for (const f of this.selectedFragments) drawFragmentHighlight(ctx, f, delta);
      if (this.mode === 'selected') {
        const bb = this.fragmentsBBox(null);
        if (bb) this.positionBar(bb);
      }
    },

    showBar() {
      if (!this.bar) return;
      this.bar.querySelector('.dw-selbar-count').textContent = this.selectedFragments.length;
      this.bar.style.display = 'flex';
    },
    hideBar() {
      if (this.bar) this.bar.style.display = 'none';
    },
    positionBar(bb) {
      if (!this.bar || this.bar.style.display === 'none') return;
      let left = bb.minX - window.scrollX;
      let top = bb.minY - window.scrollY - 36;
      left = clamp(left, 8, window.innerWidth - 170);
      top = clamp(top, 8, window.innerHeight - 40);
      this.bar.style.left = left + 'px';
      this.bar.style.top = top + 'px';
    },
  };

  // 画选择区域轮廓(矩形或套索多边形)
  function drawRegionOutline(ctx, region) {
    ctx.save();
    ctx.strokeStyle = '#2f7bff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    if (region.type === 'rect') {
      const r = region.r;
      ctx.fillStyle = 'rgba(47,123,255,0.08)';
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    } else {
      const pts = region.pts;
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        if (pts.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fillStyle = 'rgba(47,123,255,0.06)';
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // 选中片段的高光(蓝色发光描边)
  function drawFragmentHighlight(ctx, f, delta) {
    ctx.save();
    ctx.shadowColor = '#4da3ff';
    ctx.shadowBlur = 12;
    if (delta) {
      drawStroke(ctx, Object.assign({}, f, {
        points: f.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y, p: p.p, tilt: p.tilt })),
      }));
    } else {
      drawStroke(ctx, f);
    }
    ctx.restore();
  }

  // 平移一笔(复制出新对象,新 id,供移动/预览用)
  function translateStroke(s, dx, dy) {
    return Object.assign({}, s, {
      id: ++Input._uid,
      points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p, tilt: p.tilt })),
    });
  }

  // ── 浮动工具栏 ─────────────────────────────────────────────
  const Toolbar = {
    el: null,
    _fadeTimer: 0,
    _els: {},

    init() {
      this.el = document.createElement('div');
      this.el.id = 'dw-toolbar';
      this.el.innerHTML =
        '<div id="dw-drag"><span>🖌 Web Draw</span>' +
        '<button id="dw-min" title="收起/展开">–</button></div>' +
        '<div class="dw-body">' +
          '<div class="dw-sec dw-tools"></div>' +
          '<div class="dw-sec dw-selmode-row" id="dw-selmode-row">' +
            '<button id="dw-selmode-rect" title="矩形框选">▭ 框选</button>' +
            '<button id="dw-selmode-lasso" title="不规则套索(自由圈选)">⤫ 套索</button>' +
          '</div>' +
          '<div class="dw-sec dw-styles">' +
            '<div class="dw-row dw-swatches"></div>' +
            '<div class="dw-row dw-size-row">' +
              '<span class="dw-label" id="dw-size-label">粗细</span>' +
              '<input id="dw-size" type="range" min="1" max="40" step="1">' +
              '<span class="dw-size-value" id="dw-size-value">4</span>' +
            '</div>' +
            '<div class="dw-row dw-size-row">' +
              '<span class="dw-label">透明度</span>' +
              '<input id="dw-opacity" type="range" min="5" max="100" step="1">' +
              '<span class="dw-size-value" id="dw-opacity-value">100%</span>' +
            '</div>' +
          '</div>' +
          '<div class="dw-sec">' +
            '<div class="dw-row dw-btns">' +
              '<button id="dw-undo" title="撤销 Ctrl+Z">撤销</button>' +
              '<button id="dw-clear" title="清空全部草稿">清空</button>' +
            '</div>' +
            '<div class="dw-row dw-btns">' +
              '<button id="dw-hide" title="隐藏/显示草稿 H">隐藏</button>' +
              '<button id="dw-export" title="导出截图 Ctrl+S">导出</button>' +
              '<button id="dw-mouse" title="用鼠标画画(默认关闭)">🖱 鼠标</button>' +
              '<button id="dw-help" title="快捷键一览">⌨ 快捷键</button>' +
              '<button id="dw-exit" title="退出 Esc">退出</button>' +
            '</div>' +
          '</div>' +
          '<details class="dw-sec dw-settings">' +
            '<summary>⚙ 设置</summary>' +
            '<div class="dw-row dw-size-row">' +
              '<span class="dw-label">压感曲线</span>' +
              '<input id="dw-pexp" type="range" min="30" max="150" step="5">' +
              '<span class="dw-size-value" id="dw-pexp-value">0.70</span>' +
            '</div>' +
            '<div class="dw-row dw-size-row">' +
              '<span class="dw-label">最小线宽</span>' +
              '<input id="dw-pmin" type="range" min="0" max="40" step="1">' +
              '<span class="dw-size-value" id="dw-pmin-value">15%</span>' +
            '</div>' +
            '<div class="dw-row dw-opt">' +
              '<label><input id="dw-autosave" type="checkbox" checked> 自动保存草稿</label>' +
            '</div>' +
          '</details>' +
        '</div>';
      root.appendChild(this.el);

      this._els = {
        tools: this.el.querySelector('.dw-tools'),
        size: this.el.querySelector('#dw-size'),
        sizeValue: this.el.querySelector('#dw-size-value'),
        sizeLabel: this.el.querySelector('#dw-size-label'),
        opacity: this.el.querySelector('#dw-opacity'),
        opacityValue: this.el.querySelector('#dw-opacity-value'),
        pexp: this.el.querySelector('#dw-pexp'),
        pexpValue: this.el.querySelector('#dw-pexp-value'),
        pmin: this.el.querySelector('#dw-pmin'),
        pminValue: this.el.querySelector('#dw-pmin-value'),
        autosave: this.el.querySelector('#dw-autosave'),
        hide: this.el.querySelector('#dw-hide'),
      };

      this._buildTools();
      this._buildSwatches();

      this._els.size.addEventListener('input', () => {
        SETTINGS.width = parseInt(this._els.size.value, 10);
        this._els.sizeValue.textContent = SETTINGS.width;
      });
      this._els.opacity.addEventListener('input', () => {
        SETTINGS.opacity = parseInt(this._els.opacity.value, 10) / 100;
        this._els.opacityValue.textContent = this._els.opacity.value + '%';
      });
      this._els.pexp.addEventListener('input', () => {
        SETTINGS.pressureExp = parseInt(this._els.pexp.value, 10) / 100;
        this._els.pexpValue.textContent = (SETTINGS.pressureExp).toFixed(2);
      });
      this._els.pmin.addEventListener('input', () => {
        SETTINGS.pressureMin = parseInt(this._els.pmin.value, 10) / 100;
        this._els.pminValue.textContent = this._els.pmin.value + '%';
      });
      this._els.autosave.addEventListener('change', () => {
        SETTINGS.autoSave = this._els.autosave.checked;
        if (!SETTINGS.autoSave) Persist.clear();
      });

      const bind = (id, fn) => {
        this.el.querySelector('#' + id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      };
      bind('dw-undo', () => App.undo());
      bind('dw-clear', () => App.clear());
      bind('dw-hide', () => App.toggleHide());
      bind('dw-export', () => Export.run());
      bind('dw-exit', () => App.exit());
      bind('dw-mouse', () => { SETTINGS.drawWithMouse = !SETTINGS.drawWithMouse; this.sync(); });
      bind('dw-help', () => this.toggleHelp());
      this.el.querySelector('#dw-selmode-rect').addEventListener('click', (e) => {
        e.stopPropagation();
        SETTINGS.selectMode = 'rect';
        this.sync();
      });
      this.el.querySelector('#dw-selmode-lasso').addEventListener('click', (e) => {
        e.stopPropagation();
        SETTINGS.selectMode = 'lasso';
        this.sync();
      });
      this.el.querySelector('#dw-min').addEventListener('click', (e) => {
        e.stopPropagation();
        this.el.classList.toggle('dw-collapsed');
      });
      this._buildHelp();

      initDrag(this.el);

      this._hWake = () => {
        this.el.classList.remove('dw-faded');
        clearTimeout(this._fadeTimer);
        this._fadeTimer = setTimeout(() => this.el.classList.add('dw-faded'), 3000);
      };
      this.el.addEventListener('pointerenter', this._hWake);
      this.el.addEventListener('pointermove', this._hWake);
      this._fadeTimer = setTimeout(() => this.el.classList.add('dw-faded'), 3000);

      this.sync();
    },

    _buildTools() {
      TOOL_ORDER.forEach((t) => {
        const def = TOOL_DEFS[t];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dw-tool';
        b.dataset.tool = t;
        b.innerHTML = '<span class="dw-tool-icon">' + def.icon + '</span><span class="dw-tool-name">' + def.name + '</span>';
        b.title = def.name + (def.shortcut ? ' (' + def.shortcut + ')' : '');
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', () => App.selectTool(t));
        this._els.tools.appendChild(b);
      });
    },

    _buildSwatches() {
      const row = this.el.querySelector('.dw-swatches');
      SWATCHES.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dw-swatch';
        b.style.background = c;
        b.dataset.color = c;
        b.title = c;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', () => App.setColor(c));
        row.appendChild(b);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'dw-custom-color';
      custom.title = '自定义颜色';
      custom.value = SETTINGS.color;
      custom.addEventListener('pointerdown', (e) => e.stopPropagation());
      custom.addEventListener('input', () => App.setColor(custom.value));
      row.appendChild(custom);
    },

    _buildHelp() {
      this.helpPanel = document.createElement('div');
      this.helpPanel.id = 'dw-shortcuts';
      this.helpPanel.style.display = 'none';
      let rows = '';
      for (const [k, v] of SHORTCUT_LIST) rows += '<tr><td class="dw-k">' + k + '</td><td>' + v + '</td></tr>';
      this.helpPanel.innerHTML =
        '<div class="dw-shortcuts-head"><span>⌨ 快捷键</span><button id="dw-shortcuts-close" title="关闭">×</button></div>' +
        '<table>' + rows + '</table>';
      this.helpPanel.querySelector('#dw-shortcuts-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleHelp(false);
      });
      root.appendChild(this.helpPanel);
    },
    toggleHelp(open) {
      if (!this.helpPanel) return;
      const show = open === undefined ? this.helpPanel.style.display === 'none' : open;
      this.helpPanel.style.display = show ? 'block' : 'none';
    },
    closeHelp() { this.toggleHelp(false); },
    isHelpOpen() { return !!(this.helpPanel && this.helpPanel.style.display !== 'none'); },

    // 从 SETTINGS 同步全部控件
    sync() {
      const def = TOOL_DEFS[SETTINGS.tool];
      // 工具按钮激活态
      this._els.tools.querySelectorAll('.dw-tool').forEach((b) => {
        b.classList.toggle('dw-active', b.dataset.tool === SETTINGS.tool);
      });
      // 粗细滑杆范围/标签
      this._els.size.min = def.wMin;
      this._els.size.max = def.wMax;
      SETTINGS.width = clamp(SETTINGS.width, def.wMin, def.wMax);
      this._els.size.value = SETTINGS.width;
      this._els.sizeValue.textContent = SETTINGS.width;
      this._els.sizeLabel.textContent = SIZE_LABELS[SETTINGS.tool];
      // 透明度
      this._els.opacity.value = Math.round(SETTINGS.opacity * 100);
      this._els.opacityValue.textContent = this._els.opacity.value + '%';
      // 压感
      this._els.pexp.value = Math.round(SETTINGS.pressureExp * 100);
      this._els.pexpValue.textContent = SETTINGS.pressureExp.toFixed(2);
      this._els.pmin.value = Math.round(SETTINGS.pressureMin * 100);
      this._els.pminValue.textContent = this._els.pmin.value + '%';
      // 开关
      this._els.autosave.checked = SETTINGS.autoSave;
      const hide = this._els.hide;
      hide.textContent = SETTINGS.showDrafts ? '隐藏' : '显示';
      hide.classList.toggle('dw-active', !SETTINGS.showDrafts);
      const mouse = this.el.querySelector('#dw-mouse');
      mouse.textContent = SETTINGS.drawWithMouse ? '🖱 鼠标:开' : '🖱 鼠标';
      mouse.classList.toggle('dw-active', SETTINGS.drawWithMouse);
      // 选择方式切换(仅选择工具激活时显示)
      const selRow = this.el.querySelector('#dw-selmode-row');
      if (selRow) {
        selRow.style.display = SETTINGS.tool === 'select' ? 'flex' : 'none';
        this.el.querySelector('#dw-selmode-rect').classList.toggle('dw-active', SETTINGS.selectMode === 'rect');
        this.el.querySelector('#dw-selmode-lasso').classList.toggle('dw-active', SETTINGS.selectMode === 'lasso');
      }
      this.setColor(SETTINGS.color);
    },

    syncAutoSave() {
      if (this._els.autosave) this._els.autosave.checked = SETTINGS.autoSave;
    },

    setColor(c) {
      SETTINGS.color = c;
      this.el.querySelectorAll('.dw-swatch').forEach((b) => {
        b.classList.toggle('active', b.dataset.color === c);
      });
      const custom = this.el.querySelector('.dw-custom-color');
      if (custom && custom.value !== c) custom.value = c;
    },

    destroy() {
      clearTimeout(this._fadeTimer);
      if (this.helpPanel) {
        this.helpPanel.remove();
        this.helpPanel = null;
      }
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
    },
  };

  function initDrag(toolbar) {
    const header = toolbar.querySelector('#dw-drag');
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const tw = toolbar.offsetWidth;
      const th = toolbar.offsetHeight;
      const maxL = Math.max(0, window.innerWidth - Math.min(tw, 80));
      const maxT = Math.max(0, window.innerHeight - 32);
      toolbar.style.left = clamp(ox + dx, 0, maxL) + 'px';
      toolbar.style.top = clamp(oy + dy, 0, maxT) + 'px';
      toolbar.style.right = 'auto';
      e.preventDefault();
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.button !== 0) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = toolbar.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function toast(msg) {
    let el = root && root.querySelector('.dw-toast');
    if (!el && root) {
      el = document.createElement('div');
      el.className = 'dw-toast';
      root.appendChild(el);
    }
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = 'none'; }, 2800);
  }

  // ── 状态机与装配 ───────────────────────────────────────────
  let root = null;

  const App = {
    alive: false,
    _prevTool: 'pen',

    init() {
      if (this.alive) return;
      this.alive = true;

      root = document.createElement('div');
      root.id = 'draw-root';
      document.documentElement.appendChild(root);

      Toolbar.init();
      Selection.init();
      Renderer.init();
      Input.init();
      Persist.init();

      this._hKey = (e) => this.keydown(e);
      document.addEventListener('keydown', this._hKey, true);

      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight <= window.innerHeight &&
          document.body && document.body.scrollHeight > window.innerHeight) {
        toast('提示:此页面滚动结构特殊,草稿可能不跟随内容滚动');
      }

      notify(true);
    },

    destroy() {
      if (!this.alive) return;
      this.alive = false;
      document.removeEventListener('keydown', this._hKey, true);
      Editor.cancel();
      Selection.destroy();
      Input.destroy();
      Renderer.destroy();
      Persist.destroy();
      Toolbar.destroy();
      if (root) {
        root.remove();
        root = null;
      }
      notify(false);
    },

    selectTool(t) {
      Editor.commit();
      if (t !== 'select') Selection.clear();   // 切到别的工具时取消选择
      if (t === 'eraser' && SETTINGS.tool !== 'eraser') this._prevTool = SETTINGS.tool;
      SETTINGS.tool = t;
      Toolbar.sync();
    },

    setColor(c) {
      Editor.commit();
      Toolbar.setColor(c);
    },

    undo() {
      Editor.commit();
      Selection.clear();
      if (Store.undo()) {
        Renderer.redrawStatic();
        Renderer.presentLive();
      }
    },

    clear() {
      Editor.commit();
      Selection.clear();
      if (Store.clear()) {
        Renderer.redrawStatic();
        Renderer.presentLive();
      }
    },

    toggleHide() {
      Editor.commit();
      SETTINGS.showDrafts = !SETTINGS.showDrafts;
      Renderer.redrawStatic();
      Renderer.presentLive();
      Toolbar.sync();
    },

    exit() { this.destroy(); },

    keydown(e) {
      if (isEditable(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (Toolbar.isHelpOpen()) Toolbar.closeHelp();
        else if (Selection.hasSelection()) Selection.clear();
        else this.destroy();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (Selection.hasSelection()) {
          e.preventDefault();
          Selection.deleteSelected();
        }
      } else if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();
        this.undo();
      } else if (ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        Export.run();
      } else if (ctrl || e.altKey || e.metaKey) {
        return;
      } else if (e.key === 'b' || e.key === 'B') {
        const i = BRUSH_TOOLS.indexOf(SETTINGS.tool);
        const next = BRUSH_TOOLS[(i + 1) % BRUSH_TOOLS.length];
        this.selectTool(next);
      } else if (e.key === 'e' || e.key === 'E') {
        this.selectTool(SETTINGS.tool === 'eraser' ? (this._prevTool || 'pen') : 'eraser');
      } else if (e.key === 't' || e.key === 'T') {
        this.selectTool('text');
      } else if (e.key === 'v' || e.key === 'V') this.selectTool('select');
      else if (e.key === 'l' || e.key === 'L') this.selectTool('line');
      else if (e.key === 'a' || e.key === 'A') this.selectTool('arrow');
      else if (e.key === 'r' || e.key === 'R') this.selectTool('rect');
      else if (e.key === 'o' || e.key === 'O') this.selectTool('ellipse');
      else if (e.key === 'h' || e.key === 'H') this.toggleHide();
      else if (e.key === '?') { e.preventDefault(); Toolbar.toggleHelp(); }
      else if (e.key === '[') { SETTINGS.width = clamp(SETTINGS.width - 2, TOOL_DEFS[SETTINGS.tool].wMin, TOOL_DEFS[SETTINGS.tool].wMax); Toolbar.sync(); }
      else if (e.key === ']') { SETTINGS.width = clamp(SETTINGS.width + 2, TOOL_DEFS[SETTINGS.tool].wMin, TOOL_DEFS[SETTINGS.tool].wMax); Toolbar.sync(); }
    },
  };

  function notify(on) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'dw:state', on: on });
      }
    } catch (err) { /* 非扩展环境忽略 */ }
  }

  // ── 入口:幂等开关 ──────────────────────────────────────────
  if (window.__dwInstance && window.__dwInstance.alive) {
    window.__dwInstance.destroy();
  } else {
    window.__dwInstance = App;
    App.init();
  }
})();
