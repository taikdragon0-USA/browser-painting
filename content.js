// ============================================================
// Web Draw — 网页绘画 content script
// 在任意网页之上用触控笔/鼠标画画,草稿锚定在"页面坐标",随网页滚动而移动。
//
// 架构(单个 IIFE,内部按命名空间模块划分):
//   Coord     坐标换算(页面坐标 <-> 视口坐标)
//   Store     已提交笔迹的纯数据层
//   Renderer  双 canvas 渲染:
//              · 静态层 = 全页尺寸画布,绝对定位在文档流中,由浏览器随页面原生滚动
//                → 草稿与网页内容零错位,滚动时无需任何重绘
//              · 实时层 = 视口尺寸画布,仅叠加"进行中"的笔画
//   Input     指针分流(pen 画 / touch 放行 / mouse 可选),document capture 监听
//   Toolbar   浮动工具栏(颜色/粗细/撤销/清空/鼠标画开关/退出/拖动)
//   App       状态机与装配;window.__dwInstance 幂等开关
//
// 关键机制:
//   1. 滚动锚定 —— 笔迹以页面坐标(absolute)存储;静态画布是文档流的一部分,
//      滚动由浏览器合成器原生完成 → 快速滚动也零位移、零复位。
//   2. 智能输入 —— 画布 pointer-events:none,所有 pointer 监听挂在 document
//      capture 阶段,按 pointerType 分流:pen 落下即画并临时给 <html> 加
//      data-dw-lock(touch-action:none)冻结笔画期间的整页 panning;
//      touch/mouse 完全放行,手指滚动、鼠标滚轮照常。
//   3. 压感 —— 数位板(高漫 1060 Pro)经 Windows Ink 被识别为 pointerType:'pen',
//      event.pressure(0~1) 即 8192 级压感;落笔判定用 e.buttons&1(悬空不发笔),
//      高速书写用 getCoalescedEvents() 取回全部采样。
// ============================================================
(function () {
  'use strict';

  // ── 常量 / 设置 ────────────────────────────────────────────
  const Z_INDEX = 2147483647;
  const MAX_STROKES = 2000;       // 笔迹总量上限(超出自动丢弃最早)
  const MAX_POINTS = 5000;        // 单笔采样点数上限
  const MIN_DIST = 1.2;           // 采样最小间距(css px),去重减点
  const PRESSURE_EXP = 0.7;       // 压感幂次曲线指数(<1:轻笔易出细线,重笔更饱满)
  const PRESSURE_MIN = 0.15;      // 最小线宽比例(防断线)
  const SWATCHES = ['#ff3b30', '#ffa400', '#ffe10a', '#1fcecb', '#2f7bff', '#1c1c1c'];

  // 全页静态画布的设备像素上限(超长/超高页面自动降分辨率,保证内存可控)
  const MAX_CANVAS_AREA = 24 * 1024 * 1024;   // ~25MP ≈ 96MB
  const MAX_CANVAS_DIM = 32767;               // Chrome 单边尺寸上限

  // 可通过 window.DW_CONFIG 覆盖(dev-test.html 用)
  const SETTINGS = Object.assign(
    { color: '#ff3b30', width: 4, drawWithMouse: false },
    window.DW_CONFIG || {}
  );

  // ── 工具函数 ───────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }

  // 画布有效分辨率:全页画布尺寸超出上限时按比例降 dpr,超长页面仍可工作
  function computeEffDpr(w, h, dpr) {
    let eff = dpr;
    if (w * eff > MAX_CANVAS_DIM) eff = MAX_CANVAS_DIM / w;
    if (h * eff > MAX_CANVAS_DIM) eff = Math.min(eff, MAX_CANVAS_DIM / h);
    const area = (w * eff) * (h * eff);
    if (area > MAX_CANVAS_AREA) eff = Math.sqrt(MAX_CANVAS_AREA / (w * h));
    return Math.max(0.25, Math.min(dpr, eff));
  }

  // ── 坐标换算 ───────────────────────────────────────────────
  const Coord = {
    // 事件坐标(clientX/Y 布局视口) → 页面坐标
    toPage(ev) {
      return { x: ev.clientX + window.scrollX, y: ev.clientY + window.scrollY };
    },
    dist(a, b) {
      const dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    },
  };

  // ── 数据层(只存已提交笔迹) ────────────────────────────────
  const Store = {
    strokes: [],
    add(s) {
      this.strokes.push(s);
      if (this.strokes.length > MAX_STROKES) this.strokes.shift();
    },
    undo() {
      if (!this.strokes.length) return false;
      this.strokes.pop();
      return true;
    },
    clear() {
      if (!this.strokes.length) return false;
      this.strokes = [];
      return true;
    },
  };

  // ── 压感与线条 ─────────────────────────────────────────────
  function normPressure(p) { return Math.pow(clamp(p, 0, 1), PRESSURE_EXP); }

  function widthFor(stroke, pt) {
    return stroke.width * (PRESSURE_MIN + (1 - PRESSURE_MIN) * normPressure(pt.p));
  }

  // 三点加权平滑(1:2:1),轻去抖;点数 < 3 原样返回
  function smoothStroke(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      out.push({
        x: (a.x + 2 * b.x + c.x) / 4,
        y: (a.y + 2 * b.y + c.y) / 4,
        p: (a.p + 2 * b.p + c.p) / 4,
      });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // 逐段变宽圆帽描边;单点 = 轻点画圆
  function drawStroke(ctx, stroke) {
    const pts = smoothStroke(stroke.points);
    if (!pts.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, widthFor(stroke, pts[0]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = (widthFor(stroke, a) + widthFor(stroke, b)) / 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // ── 渲染器 ─────────────────────────────────────────────────
  // 静态层(全页画布):absolute 定位在文档流顶部,随页面原生滚动 → 滚动零错位。
  // 实时层(视口画布):fixed 覆盖视口,只在画的过程中叠加活动笔画,提交后清空。
  const Renderer = {
    canvas: null,          // 实时层(视口)
    staticCanvas: null,    // 静态层(全页)
    ctx: null, staticCtx: null,
    _size: { w: 0, h: 0, dpr: 1, eff: 1 },
    liveRaf: 0,

    init() {
      // 静态层:文档流,由浏览器与网页内容一起滚动
      this.staticCanvas = document.createElement('canvas');
      this.staticCtx = this.staticCanvas.getContext('2d');
      Object.assign(this.staticCanvas.style, {
        position: 'absolute',
        left: '0', top: '0',
        pointerEvents: 'none',
        zIndex: String(Z_INDEX - 1),
      });
      (document.body || document.documentElement).appendChild(this.staticCanvas);

      // 实时层:视口固定,叠加进行中的笔画
      this.canvas = document.createElement('canvas');
      this.canvas.id = 'dw-canvas';
      this.ctx = this.canvas.getContext('2d');
      Object.assign(this.canvas.style, {
        position: 'fixed',
        left: '0', top: '0',
        pointerEvents: 'none',
        zIndex: String(Z_INDEX - 1),
      });
      root.appendChild(this.canvas);

      // 静态层在文档流中,滚动无需重绘;滚动只需让实时层跟随(有活动笔画时)
      this._hScroll = () => { if (Input.activePointers.size) this.requestLive(); };
      this._hResize = () => { this._checkSize(); this.presentLive(); };
      this._hVV = () => this.presentLive();
      window.addEventListener('scroll', this._hScroll, { passive: true });
      window.addEventListener('resize', this._hResize, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this._hVV);
        window.visualViewport.addEventListener('scroll', this._hVV);
      }

      // 页面尺寸轮询(SPA 动态加载 / 懒加载图片撑高页面 / 缩放),变化才重绘
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

    redrawStatic() {
      if (!this.staticCtx) return;
      const s = this._size;
      const ctx = this.staticCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
      ctx.restore();
      ctx.setTransform(s.eff, 0, 0, s.eff, 0, 0);   // 页面坐标 × eff → 设备像素
      for (const stroke of Store.strokes) drawStroke(ctx, stroke);
    },

    // 实时层渲染:清屏后在视口偏移下重画全部活动笔画
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
      if (!Input.activePointers.size) return;
      ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr);
      for (const [, s] of Input.activePointers) drawStroke(ctx, s);
    },

    requestLive() {
      if (this.liveRaf) return;
      this.liveRaf = requestAnimationFrame(() => {
        this.liveRaf = 0;
        this.presentLive();
      });
    },

    // 提交完成的笔画 → 画进全页静态层(页面坐标),清实时层
    commitStroke(stroke) {
      Store.add(stroke);
      const ctx = this.staticCtx;
      if (ctx) {
        ctx.setTransform(this._size.eff, 0, 0, this._size.eff, 0, 0);
        drawStroke(ctx, stroke);
      }
      this.presentLive();
    },
  };

  // ── 输入分流(document capture;画布 pointer-events:none) ────
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

    onDown(e) {
      if (this.isToolbarTarget(e.target)) return;   // 工具栏自处理,不起笔画
      const t = e.pointerType;
      const isPen = t === 'pen' || t === 'eraser';
      const isMouseDraw = t === 'mouse' && SETTINGS.drawWithMouse;
      if (!isPen && !isMouseDraw) return;           // touch / mouse(放行)→ 什么都不做,页面照常滚动
      if (!(e.buttons & 1)) return;                 // 悬空 / 非主键按下 → 不算落笔
      e.preventDefault();                           // 阻止默认动作(选字/聚焦);注意:不靠它挡滚动
      if (isPen) this.lockPen();                    // 笔画期间冻结整页 panning
      this.activePointers.set(e.pointerId, {
        id: ++this._uid,
        color: SETTINGS.color,
        width: SETTINGS.width,
        pointerType: t,
        points: [pointFromEvent(e)],
      });
      Renderer.requestLive();
    },

    onMove(e) {
      const stroke = this.activePointers.get(e.pointerId);
      if (!stroke) return;                          // 无进行中笔画
      // 数位板 200Hz+ 采样,Chrome 只派发合并后的 move → 先取回全部采样再判断
      const samples = (e.getCoalescedEvents && e.pointerType === 'pen')
        ? e.getCoalescedEvents()
        : [e];
      let hadContact = false;
      for (const s of samples) {
        if (!(s.buttons & 1)) continue;
        hadContact = true;
        const pt = pointFromEvent(s);
        const last = stroke.points[stroke.points.length - 1];
        if (last && Coord.dist(pt, last) < MIN_DIST) continue;
        stroke.points.push(pt);
        if (stroke.points.length >= MAX_POINTS) break;
      }
      if (hadContact) {
        e.preventDefault();
        Renderer.requestLive();
      } else if (!(e.buttons & 1)) {
        // 已抬笔但没收到 pointerup(个别设备/系统):按抬笔保险收尾
        this.endStroke(e.pointerId);
        if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
      }
    },

    onUp(e) {
      this.endStroke(e.pointerId);
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
    },

    onCancel(e) {
      this.endStroke(e.pointerId);                  // 系统打断:保留已画部分
      if (e.pointerType === 'pen' || e.pointerType === 'eraser') this.unlockPen();
    },

    endStroke(pointerId) {
      const stroke = this.activePointers.get(pointerId);
      this.activePointers.delete(pointerId);
      if (!stroke) return;
      if (stroke.points.length) Renderer.commitStroke(stroke);
      else Renderer.requestLive();                  // 空笔画,清掉可能的实时残影
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
    // 鼠标无压力,取满宽;pen 的 pressure 0~1(8192 级压感归一)
    let p = ev.pointerType === 'mouse' ? 1 : (typeof ev.pressure === 'number' ? ev.pressure : 1);
    if (!(p > 0)) p = 1;
    return {
      x: pg.x,
      y: pg.y,
      p: p,
      tilt: [ev.tiltX || 0, ev.tiltY || 0],
    };
  }

  // ── 浮动工具栏 ─────────────────────────────────────────────
  const Toolbar = {
    el: null,
    _fadeTimer: 0,

    init() {
      this.el = document.createElement('div');
      this.el.id = 'dw-toolbar';
      this.el.innerHTML =
        '<div id="dw-drag"><span>🖌 Web Draw</span>' +
        '<button id="dw-min" title="收起/展开">–</button></div>' +
        '<div class="dw-body">' +
          '<div class="dw-row dw-swatches"></div>' +
          '<div class="dw-row dw-size-row">' +
            '<input id="dw-size" type="range" min="2" max="20" step="1" value="' + SETTINGS.width + '">' +
            '<span class="dw-size-value" id="dw-size-value">' + SETTINGS.width + '</span>' +
          '</div>' +
          '<div class="dw-row dw-btns">' +
            '<button id="dw-undo">撤销</button>' +
            '<button id="dw-clear">清空</button>' +
            '<button id="dw-mouse" title="用鼠标画画(默认关闭,鼠标保持正常滚动/点选)">🖱 鼠标画</button>' +
            '<button id="dw-exit">退出</button>' +
          '</div>' +
        '</div>';
      root.appendChild(this.el);

      // 色板
      const swRow = this.el.querySelector('.dw-swatches');
      SWATCHES.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dw-swatch';
        b.style.background = c;
        b.dataset.color = c;
        b.title = c;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', () => this.setColor(c));
        swRow.appendChild(b);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'dw-custom-color';
      custom.title = '自定义颜色';
      custom.value = SETTINGS.color;
      custom.addEventListener('pointerdown', (e) => e.stopPropagation());
      custom.addEventListener('input', () => this.setColor(custom.value));
      swRow.appendChild(custom);

      // 粗细
      const sizeEl = this.el.querySelector('#dw-size');
      const sizeVal = this.el.querySelector('#dw-size-value');
      sizeEl.addEventListener('input', () => {
        SETTINGS.width = parseInt(sizeEl.value, 10);
        sizeVal.textContent = SETTINGS.width;
      });

      // 功能按钮
      this.el.querySelector('#dw-undo').addEventListener('click', (e) => { e.stopPropagation(); App.undo(); });
      this.el.querySelector('#dw-clear').addEventListener('click', (e) => { e.stopPropagation(); App.clear(); });
      this.el.querySelector('#dw-exit').addEventListener('click', (e) => { e.stopPropagation(); App.exit(); });

      const mouseBtn = this.el.querySelector('#dw-mouse');
      const syncMouse = () => {
        mouseBtn.classList.toggle('dw-active', SETTINGS.drawWithMouse);
        mouseBtn.textContent = SETTINGS.drawWithMouse ? '🖱 鼠标画:开' : '🖱 鼠标画';
      };
      mouseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        SETTINGS.drawWithMouse = !SETTINGS.drawWithMouse;
        syncMouse();
      });
      syncMouse();

      this.el.querySelector('#dw-min').addEventListener('click', (e) => {
        e.stopPropagation();
        this.el.classList.toggle('dw-collapsed');
      });

      initDrag(this.el);

      // 3s 无操作自动淡化成半透明,悬停/移动恢复
      this._hWake = () => {
        this.el.classList.remove('dw-faded');
        clearTimeout(this._fadeTimer);
        this._fadeTimer = setTimeout(() => this.el.classList.add('dw-faded'), 3000);
      };
      this.el.addEventListener('pointerenter', this._hWake);
      this.el.addEventListener('pointermove', this._hWake);
      this._fadeTimer = setTimeout(() => this.el.classList.add('dw-faded'), 3000);

      this.setColor(SETTINGS.color);
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
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
    },
  };

  // 工具栏拖动:按下即拖,期间在 window capture 阶段跟随,松开即停。
  // 不使用 setPointerCapture —— 捕获会把 move/up 重定向到捕获元素本身,
  // 挂在 header 上的 move/up 收不到事件,导致"停不下来"。
  function initDrag(toolbar) {
    const header = toolbar.querySelector('#dw-drag');
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const tw = toolbar.offsetWidth;
      const th = toolbar.offsetHeight;
      const maxL = Math.max(0, window.innerWidth - Math.min(tw, 80)); // 至少留 80px 在屏内
      const maxT = Math.max(0, window.innerHeight - 32);              // 标题栏不拖出屏幕
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
      if (e.target.closest('button')) return;   // 让最小化按钮点击正常走
      if (e.button !== 0) return;               // 仅左键/笔尖
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

  // ── 轻提示 ─────────────────────────────────────────────────
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

    init() {
      if (this.alive) return;
      this.alive = true;

      root = document.createElement('div');
      root.id = 'draw-root';
      document.documentElement.appendChild(root);

      Toolbar.init();
      Renderer.init();
      Input.init();

      this._hKey = (e) => this.keydown(e);
      document.addEventListener('keydown', this._hKey, true);

      // 滚动结构检测:页面靠内层容器滚动(Notion 式)时,草稿无法跟随窗口滚动
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
      Input.destroy();
      Renderer.destroy();
      Toolbar.destroy();
      if (root) {
        root.remove();
        root = null;
      }
      notify(false);
    },

    undo() {
      if (Store.undo()) {
        Renderer.redrawStatic();
        Renderer.presentLive();
      }
    },
    clear() {
      if (Store.clear()) {
        Renderer.redrawStatic();
        Renderer.presentLive();
      }
    },
    exit() { this.destroy(); },

    keydown(e) {
      if (isEditable(e.target)) return;                    // 输入框内不劫持
      if (e.key === 'Escape') {
        e.preventDefault();
        this.destroy();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();                               // 绘画模式下接管 Ctrl+Z 撤销
        this.undo();
      }
    },
  };

  function notify(on) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'dw:state', on: on });
      }
    } catch (err) { /* 非扩展环境忽略 */ }
  }

  // ── 入口:幂等开关(点图标开/关) ────────────────────────────
  if (window.__dwInstance && window.__dwInstance.alive) {
    window.__dwInstance.destroy();   // 已有实例 → 关闭
  } else {
    window.__dwInstance = App;       // 无实例 → 开启
    App.init();
  }
})();
