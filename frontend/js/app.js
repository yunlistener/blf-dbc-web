/* CANoe 风格前端逻辑:文件 → 报文树 → 多信号曲线 → Trace → 统计 */
"use strict";

// 版本号:自动从 app.js 的 ?v=N 参数读取(与缓存版本号一致,只维护 index.html 一处)
const APP_VERSION = (document.currentScript && document.currentScript.src.match(/[?&]v=(\d+)/) || [])[1] || "?";
// 页头显示版本号(script 在 body 底部,DOM 已就绪)
const _verEl = document.getElementById("app-version");
if (_verEl) _verEl.textContent = "v" + APP_VERSION;

const PALETTE = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff",
                 "#4dd6c8", "#f472b6", "#a3e635", "#fb923c", "#60a5fa",
                 "#fda4af", "#93c5fd", "#c4b5fd", "#86efac", "#fcd34d",
                 "#7dd3fc", "#f0abfc", "#bef264", "#fdba74", "#a5b4fc"];  // 20 色循环
const MAX_SERIES = 64;   // 最多同时显示 64 个信号

const state = {
  blf: null,
  dbc: null,
  stats: null,
  signals: [],       // 已选信号 [{frame_id, signal, unit, color, slot, data, channel, dbc, plotId}]
  plots: [],         // 示波器 [{id, el, canvasEl, chart, series, sigs: [...]}]
  plotIds: [],       // 示波器 id 有序列表(含空示波器)
  plotSeq: 1,        // 下一个示波器 ID
  xRange: null,      // 时间轴同步范围(缩放后 {min, max});null = 自动
  trace: { frameId: null, channel: null, offset: 0, limit: 200, search: null, range: null },
  config: {},        // 工程配置(总线/波特率/文件/通道映射)
  channels: [],      // [{channel, frames, dbc, messages}]
  hasData: null,     // Set<frame_id> 日志中实际出现的报文 ID
  lastCursorT: null, // 最后光标时刻(相对秒,信号行 tooltip 显示用)
  jitterMarks: [],   // [{t, color}] 抖动峰值时间点(相对秒),示波器 x 轴标记
  anchorT: null,     // 测量锚点时间(相对秒);点击设置,再点清除
};

function showTip(msg) { document.getElementById("st-tip").textContent = msg; }

/* 信号值格式化:数值保留 6 位有效数字;值表(choices)显示名称(值);dict/数组转 JSON;null 显示 — */
function fmtVal(v) {
  if (v == null) return "—";
  if (typeof v === "number") return String(Number(v.toPrecision(6)));
  if (typeof v === "object") {
    // cantools 值表信号: {name: 'Valid', value: 0, _comments: {}}
    if ("name" in v) return v.value != null ? `${v.name}(${v.value})` : String(v.name);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}
window.addEventListener("error", (e) => {
  // 忽略 ResizeObserver 良性循环警告(浏览器自动重调度,非真实错误)
  if (e.message && e.message.includes("ResizeObserver loop")) return;
  const stack = (e.error && e.error.stack || "").split("\n")[1] || "";
  showTip("JS错误: " + e.message + " " + stack.trim());
});
window.addEventListener("unhandledrejection", (e) => { diag.errs++; showTip("异常: " + e.reason); });

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  return r.json();
}

/* ---------- 文件上传 ---------- */
let pendingFiles = [];

function openUpload() {
  pendingFiles = [];
  document.getElementById("file-input").value = "";
  renderUploadList();
  document.getElementById("upload-modal").style.display = "flex";
}

function closeUpload() {
  document.getElementById("upload-modal").style.display = "none";
}

document.getElementById("file-input").addEventListener("change", (e) => {
  pendingFiles = Array.from(e.target.files || []);
  renderUploadList();
});

const dropZone = document.getElementById("drop-zone");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  pendingFiles = Array.from(e.dataTransfer.files || []).filter(f => /\.(blf|dbc|log|txt)$/i.test(f.name));
  renderUploadList();
});

function renderUploadList() {
  const list = document.getElementById("upload-list");
  const btn = document.getElementById("btn-upload-go");
  list.innerHTML = pendingFiles.length
    ? pendingFiles.map((f, i) =>
        `<div class="upload-row" id="up-row-${i}"><span>${f.name}</span><span class="up-size">${(f.size / 1024).toFixed(1)} KB</span><span class="up-status">待上传</span></div>`).join("")
    : `<div class="hint">尚未选择文件</div>`;
  btn.disabled = pendingFiles.length === 0;
}

async function startUpload() {
  const btn = document.getElementById("btn-upload-go");
  btn.disabled = true;
  btn.textContent = "上传中…";
  let ok = 0, fail = 0;
  for (let i = 0; i < pendingFiles.length; i++) {
    const f = pendingFiles[i];
    const row = document.getElementById(`up-row-${i}`);
    const status = row.querySelector(".up-status");
    status.textContent = "上传中…";
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/api/files/upload", { method: "POST", body: fd });
      status.textContent = "✓ 完成";
      status.className = "up-status ok";
      ok++;
    } catch (err) {
      status.textContent = "✗ " + (err.message || "失败");
      status.className = "up-status err";
      fail++;
    }
  }
  btn.textContent = "上传";
  if (ok > 0) {
    showTip(`上传完成:成功 ${ok} 个${fail ? `,失败 ${fail} 个` : ""}`);
    try {
      await loadFiles();   // 重新加载文件列表和报文树(可能因缺 BLF 抛错)
    } catch (e) {
      showTip("文件列表刷新失败: " + e.message);
    }
    closeUpload();   // 无论刷新成败都关闭上传界面(之前 loadFiles 抛错会卡住不消失)
  } else {
    showTip("上传失败,请检查文件格式(.blf / .dbc)");
    btn.disabled = false;
  }
}

/* ---------- uPlot ---------- */
/* 值表信号格式化显示:数值 或 名称(值) */
function fmtSigVal(s, v) {
  if (v != null && typeof v === "number" && s.choices) {
    const c = s.choices[String(v)];
    if (c && c.name) return `${c.name}(${v})`;
  }
  return fmtVal(v);
}

/* 带单位的信号值显示:数值信号 → "92.5 °C";值表信号无单位,原样 */
function fmtSigValUnit(s, v) {
  const t = fmtSigVal(s, v);
  return (s.unit && v != null && typeof v === "number") ? `${t} ${s.unit}` : t;
}

/* 统计数值加单位(供表格用) */
function fmtUnit(s, v) {
  return (v == null) ? "—" : (s.unit ? `${v} ${s.unit}` : String(v));
}

const cursorTip = document.getElementById("cursor-tip");
function hideCursorTip() { cursorTip.style.display = "none"; }

function showCursorTipAt(x, y, html) {
  cursorTip.innerHTML = html;
  cursorTip.style.display = "block";
  // 防止超出视口边缘
  let tx = x + 14, ty = y - 12;
  const tw = cursorTip.offsetWidth, th = cursorTip.offsetHeight;
  if (tx + tw > window.innerWidth - 8) tx = x - tw - 14;
  if (ty + th > window.innerHeight - 8) ty = y - th - 14;
  cursorTip.style.left = Math.max(8, tx) + "px";
  cursorTip.style.top = Math.max(8, ty) + "px";
}

/* 光标同步/读数已由 LWC 渲染层(onCrosshair)实现,旧 uPlot 版本已删除 */

/* 抖动峰值标记显示开关(localStorage 持久化) */
function showJitterMarks() {
  return localStorage.getItem("jitterMarks") !== "0";
}
function onJitterMarkToggle() {
  localStorage.setItem("jitterMarks",
    document.getElementById("cfg-jitter-mark").checked ? "1" : "0");
  renderOverlays();
}




/* 发送 ECU 的彩色 tag HTML(信号所属报文的第一发送者) */
function ecuTagHtml(s) {
  const ecu = s.senders && s.senders.length ? s.senders[0] : "";
  if (!ecu) return "";
  const nc = nodeColor(ecu);
  return ` <span class="msg-tag" style="background:${nc}26;border-color:${nc}55;color:${nc}">${ecu}</span>`;
}

/* 已选信号行 hover:显示该信号详情(时间/ECU/值表名称/说明) */
function showSigRowTip(s, el) {
  const rect = el.getBoundingClientRect();
  const ch = state.channels.find(c => c.channel === s.channel);
  const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === s.frame_id) : null;
  const val = document.getElementById(`sigval-${s.slot}`)?.textContent || "—";
  const t = state.lastCursorT != null ? state.lastCursorT.toFixed(3) + " s" : "—";
  const html =
    `<div class="tip-row"><b>${s.signal}</b> <span class="u">${s.unit || ""}</span>${ecuTagHtml(s)}</div>` +
    `<div class="tip-dim">报文 ${msg ? msg.name : ""} (0x${s.frame_id.toString(16)}) · 通道 ${s.channel} · 时间 ${t}</div>` +
    `<div class="tip-row">当前值 <b>${val}</b></div>` +
    (s.comment ? `<div class="tip-dim" style="white-space:normal;max-width:280px">💬 ${s.comment}</div>` : "");
  showCursorTipAt(rect.right + 8, rect.top, html);
}

/* 左侧已选信号列:颜色标记 + 信号名 + 当前值 + 示波器分配 + 移除 */
function renderSigSidebar() {
  const box = document.getElementById("sig-sidebar");
  if (!state.signals.length) {
    box.innerHTML = `<div class="sig-sidebar-title">已选信号</div>
      <div class="hint" style="padding:8px;font-size:11px">点击左侧信号树选择</div>`;
    return;
  }
  box.innerHTML = `<div class="sig-sidebar-title">已选信号 (${state.signals.length}/${MAX_SERIES})
      <span class="sig-sidebar-actions">
        <button class="btn-mini" onclick="addPlot()" title="增加空示波器">+</button>
        <button class="btn-mini" onclick="removePlot()" title="删除空示波器">−</button>
        <button class="btn-mini" onclick="clearSignals()" title="清空所有信号">清空</button>
      </span></div>` +
    state.signals.map(s => `
      <div class="sig-sidebar-row" id="sigrow-${s.slot}">
        <span class="dot" style="background:${s.color}"></span>
        <span class="sname" title="${s.signal}">${s.signal}</span>
        <span class="sval" id="sigval-${s.slot}">—</span>
        <span class="srm" title="移除" onclick="removeSignal(${s.slot})">✕</span>
      </div>`).join("");
  // 行 hover → tooltip 显示信号详情
  state.signals.forEach(s => {
    const row = document.getElementById(`sigrow-${s.slot}`);
    if (!row) return;
    row.addEventListener("mouseenter", () => showSigRowTip(s, row));
    row.addEventListener("mouseleave", hideCursorTip);
  });
}

/* 从指定示波器移除信号(该信号若只在此示波器,同步从已选列表移除) */
function removeSignalFromPlot(plotId, slot) {
  pausePlayOnSignalChange();   // 播放中移除 → 自动暂停
  const s = state.signals.find(x => x.slot === slot && x.plotId === plotId);
  if (!s) return;
  state.signals = state.signals.filter(x => !(x.slot === slot && x.plotId === plotId));
  // 该信号在其他示波器还有条目则保留信号树 active
  const still = state.signals.some(x =>
    x.frame_id === s.frame_id && x.signal === s.signal && x.channel === s.channel);
  if (!still) {
    document.querySelectorAll(".sig-item.active").forEach(el => {
      if (el.dataset.sig === s.signal && String(el.dataset.ch) === String(s.channel)) {
        el.classList.remove("active");
      }
    });
  }
  saveSelectedSignals();   // 持久化
  clearPlayDataFor(s);     // 清理该信号播放累积(防删加后播放残留)
  draw();                  // 重建:目标窗口信号移除,自动重算 y 范围
  if (currentTab() === "sigstats") loadSigStats();
}

/* 清理某信号的播放累积数据(删除/重加时防残留) */
function clearPlayDataFor(s) {
  if (!s) return;
  const key = `${s.frame_id}|${s.channel}|${s.signal}`;
  delete playState.data[key];
}

/* 从已选列表移除信号 */
function removeSignal(slot) {
  pausePlayOnSignalChange();   // 播放中移除信号 → 自动暂停
  const s = state.signals.find(x => x.slot === slot);
  if (!s) return;
  state.signals = state.signals.filter(x => x !== s);
  // 该信号(frame_id+signal+channel)还有其他示波器条目则保留 active
  const still = state.signals.some(x =>
    x.frame_id === s.frame_id && x.signal === s.signal && x.channel === s.channel);
  if (!still) {
    document.querySelectorAll(".sig-item.active").forEach(el => {
      if (el.dataset.sig === s.signal && String(el.dataset.ch) === String(s.channel)) {
        el.classList.remove("active");
      }
    });
  }
  saveSelectedSignals();   // 持久化:刷新后恢复
  clearPlayDataFor(s);     // 清理该信号播放累积
  draw();   // syncPlots 会自动移除空示波器
  if (currentTab() === "sigstats") loadSigStats();
}

/* 清空所有信号(含空示波器) */
function clearSignals() {
  pausePlayOnSignalChange();   // 播放中清空 → 自动暂停
  if (!state.signals.length) return;
  state.signals = [];
  state.plotIds = [];
  state.plotSeq = 1;
  document.querySelectorAll(".sig-item.active").forEach(el => el.classList.remove("active"));
  saveSelectedSignals();   // 保存空数组 = 标记"已清空",刷新后不再自动选默认
  draw();
  if (currentTab() === "sigstats") loadSigStats();
}

/* 将信号移动到指定示波器 */
function moveSignalToPlot(slot, pid) {
  const s = state.signals.find(x => x.slot === slot);
  if (!s) return;
  s.plotId = parseInt(pid, 10);
  saveSelectedSignals();   // 窗口分配也持久化(刷新后保持合并关系)
  draw();                  // 全量重建:目标窗口 y 范围自动重算(覆盖全部信号)
}

/* 已选信号持久化(localStorage,含 blf 名防止跨文件误恢复) */
const LS_SIG = "selectedSignals";
function saveSelectedSignals() {
  try {
    localStorage.setItem(LS_SIG, JSON.stringify({
      blf: state.blf,
      signals: state.signals.map(s => ({ frame_id: s.frame_id, signal: s.signal, channel: s.channel, plotId: s.plotId })),
    }));
  } catch (e) { /* 忽略 */ }
}
// 页面关闭/刷新前兜底保存(防任何遗漏路径)
window.addEventListener("beforeunload", () => {
  if (state.signals.length) saveSelectedSignals();
});
async function restoreSelectedSignals() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SIG) || "null");
    if (!saved || saved.blf !== state.blf || !saved.signals || !saved.signals.length) return 0;
    const items = Array.from(document.querySelectorAll(".chan-group .sig-item"));
    // 恢复示波器 id 列表(含保存的 plotId,支持同信号多示波器)
    const savedIds = [...new Set(saved.signals.map(r => r.plotId).filter(x => x != null))].sort((a, b) => a - b);
    if (savedIds.length) {
      state.plotIds = savedIds;
      state.plotSeq = Math.max(state.plotSeq, ...savedIds) + 1;
    }
    let restored = 0;
    for (const rec of saved.signals.slice(0, MAX_SERIES)) {
      const item = items.find(el =>
        el.dataset.sig === rec.signal &&
        el.dataset.ch === String(rec.channel) &&
        parseInt(el.closest(".msg-item").querySelector(".msg-id").textContent, 16) === rec.frame_id);
      const ch = state.channels.find(c => c.channel === rec.channel);
      const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === rec.frame_id) : null;
      if (msg && state.hasData && state.hasData.has(rec.frame_id)) {
        const ok = await addSignal(msg, rec.signal, rec.channel, rec.plotId ?? null);
        if (ok) { restored++; if (item) item.classList.add("active"); }
      }
    }
    return restored;
  } catch (e) {
    return 0;
  }
}

/* ============ 多示波器示波器(CANoe 式) ============ */
const diagTime = { draw: 0, lastDraw: 0, updates: 0 };
function draw() {
  const _t0 = performance.now();
  showPlaybar(state.signals.length > 0);   // 有信号才显示播放控制栏
  renderSigSidebar();   // 左侧已选信号列(含示波器分配下拉)
  if (!state.signals.length) {
    state.plots.forEach(p => { if (p.chart) p.chart.destroy(); p.el.remove(); });
    state.plots = [];
    hideCursorTip();
    return;
  }
  syncPlots();
  const _dt = performance.now() - _t0;
  diagTime.lastDraw = _dt;
  diagTime.draw = diagTime.draw * 0.9 + _dt * 0.1;
  diagTime.updates++;
}

/* 按示波器 id 列表同步所有 plot 实例(含空示波器) */
function syncPlots() {
  const wrap = document.getElementById("plot-wrap");
  const ids = state.plotIds.slice().sort((a, b) => a - b);
  const keep = new Set(ids);
  // 销毁消失的示波器
  state.plots = state.plots.filter(p => {
    if (!keep.has(p.id)) { if (p.chart) p.chart.destroy(); p.el.remove(); return false; }
    return true;
  });
  // 创建缺失的示波器容器
  ids.forEach(id => {
    let p = state.plots.find(x => x.id === id);
    if (!p) {
      const el = document.createElement("div");
      el.className = "plot-item";
      const title = document.createElement("div");
      title.className = "plot-title";
      el.appendChild(title);
      const canvasEl = document.createElement("div");
      canvasEl.className = "plot-canvas";
      el.appendChild(canvasEl);
      wrap.appendChild(el);
      p = { id, el, canvasEl, chart: null, series: {}, title };
      state.plots.push(p);
    }
    p.sigs = state.signals.filter(s => s.plotId === id);
  });
  state.plots.forEach(p => updatePlotData(p));
  resizeChart();   // 强制同步所有窗口尺寸(防创建时布局未就绪导致画布异常)
}

/* 添加一个空示波器 */
function addPlot() {
  state.plotIds.push(state.plotSeq++);
  draw();
}
/* 移除最后一个空示波器(非空提示) */
function removePlot() {
  for (let i = state.plotIds.length - 1; i >= 0; i--) {
    if (!state.signals.some(s => s.plotId === state.plotIds[i])) {
      state.plotIds.splice(i, 1);
      draw();
      return;
    }
  }
  showTip("所有示波器都含有信号,请先移除信号再删除示波器");
}

/* 单个示波器的数据与实例 */
/* ============ Lightweight Charts 渲染层(v94,替代 uPlot) ============
   独立时间轴:每信号自己的 series(方案 A 原生支持,无桶对齐);
   共享 y 轴:priceScaleId 统一 'left'(LWC 自动聚合全部 series 范围);
   限窗:MIN_WINDOW_MS 最小缩放窗口,控制同屏点数 */
const MIN_WINDOW_MS = 500;      // 最小缩放窗口 0.5s(100Hz → 50 点/信号)
let clamping = false;

/* 创建 LWC 图表(每个示波器窗口一个实例) */
/* ============ Chart.js 渲染层(v99,替代 LWC/uPlot) ============
   独立 x:每 dataset 自带 [x,y] 数据(方案 A,无对齐问题)
   播放固定时间轴:scales.x.min/max 声明式(实测数据部分时保持固定)
   同窗共享 y 轴:多 dataset 同 scale,Chart.js 自动聚合全部范围
   限窗:滚轮缩放钳制 MIN_WINDOW_S 最小窗口 */
const MIN_WINDOW_S = 0.5;
let syncingX = false;

/* overlay plugin:每窗口绘制锚点红线 + 同步竖线 + 抖动三角(afterDraw) */
function makeOverlayPlugin(p) {
  return {
    id: "overlay-" + p.id,
    afterDraw(chart, args, opts) {
      const ctx = chart.ctx;
      const xa = chart.scales.x;
      if (!xa) return;
      // ⚠️ 用 chartArea(绘图区)而非 scales.x.top/bottom:
      // scales.x.top 是 x 轴顶部(偏下),导致竖线上面缺一截
      const top = chart.chartArea ? chart.chartArea.top : xa.top;
      const bottom = chart.chartArea ? chart.chartArea.bottom : xa.bottom;
      // 同步竖线(浅蓝虚线,鼠标所在窗口 + 跟随窗口)
      if (p.syncX != null) {
        const px = xa.getPixelForValue(p.syncX);
        if (px != null && isFinite(px)) {
          ctx.save();
          ctx.strokeStyle = "rgba(125,211,252,.85)";
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
          ctx.restore();
        }
      }
      // 锚点红线(所有窗口同步)
      if (state.anchorT != null) {
        const px = xa.getPixelForValue(state.anchorT);
        if (px != null && isFinite(px)) {
          ctx.save();
          ctx.strokeStyle = "rgba(255,77,77,.85)";
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#ff4d4d";
          ctx.beginPath();
          ctx.moveTo(px - 4, top + 2); ctx.lineTo(px + 4, top + 2); ctx.lineTo(px, top - 5);
          ctx.fill();
          ctx.restore();
        }
      }
      // 抖动峰值标记(时间轴顶部三角)
      if (showJitterMarks() && state.jitterMarks && state.jitterMarks.length) {
        const names = new Set(p.sigs.map(s => s.signal));
        ctx.save();
        state.jitterMarks.forEach(m => {
          if (!names.has(m.signal)) return;
          const px = xa.getPixelForValue(m.t);
          if (px == null || !isFinite(px)) return;
          ctx.fillStyle = m.color || "#ffd75e";
          ctx.beginPath();
          ctx.moveTo(px - 4, top + 2); ctx.lineTo(px + 4, top + 2); ctx.lineTo(px, top - 5);
          ctx.fill();
        });
        ctx.restore();
      }
    }
  };
}

/* 创建 Chart.js 实例(每个示波器窗口一个) */
function createPlotChart(p) {
  const el = p.canvasEl;
  el.innerHTML = "";
  const holder = document.createElement("div");
  holder.className = "chartjs-holder";
  el.appendChild(holder);
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  p.holder = holder;
  p.canvas = canvas;
  p.syncX = null;
  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear", min: 0, max: 1,
          ticks: { color: "#8a93a3", maxTicksLimit: 14, callback: v => v.toFixed(3) + "s" },
          grid: { color: "#242830" },
        },
        y: { type: "linear", grid: { color: "#242830" }, ticks: { color: "#8a93a3" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true, mode: "index", intersect: false,
          backgroundColor: "rgba(22,24,29,.95)", titleColor: "#8a93a3",
          bodyColor: "#e2e8f0", borderColor: "#3a4150", borderWidth: 1,
          callbacks: {
            title: items => (items && items[0] ? items[0].parsed.x.toFixed(3) + " s" : ""),
            label: item => {
              const ds = item.dataset;
              if (ds && ds.choices) {   // 值表信号:显示 名称(值)
                const c = ds.choices[String(item.parsed.y)];
                return `${ds.label}: ${c && c.name ? c.name : ""}(${item.parsed.y})`;
              }
              return `${ds.label}: ${fmtVal(item.parsed.y)}`;
            },
          },
        },
      },
      onHover: (e) => onPlotHover(p, e),
    },
    plugins: [makeOverlayPlugin(p)],
  });
  p.chart = chart;
  p._dkey = "";
  // 点击设/清锚点
  canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    const t = chart.scales.x.getValueForPixel(e.clientX - rect.left);
    if (t == null || !isFinite(t)) return;
    state.anchorT = (state.anchorT == null) ? t : null;
    renderOverlays();
    if (state.anchorT != null && state.lastCursorT != null) showAnchorTip();
    else hideAnchorTip();
  });
  // 移出 → 隐藏 tooltip + 清其他窗口同步竖线
  holder.addEventListener("mouseleave", () => {
    hideCursorTip(); hideAnchorTip();
    state.plots.forEach(pp => {
      if (pp.chart && pp.chart !== chart) { pp.syncX = null; pp.chart.update("none"); }
    });
    p.syncX = null;
    p.chart.update("none");
  });
  // 滚轮:Ctrl+滚轮 = 缩放(限窗 + 全窗口同步);普通滚轮 = 页面默认滚动
  // (多个示波器时普通滚动方便上下翻页,不会误缩放)
  holder.addEventListener("wheel", e => {
    if (!e.ctrlKey) return;   // 不拦截 → 页面正常滚动
    e.preventDefault();
    if (playState.playing) return;
    const xa = chart.scales.x;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t0 = xa.getValueForPixel(px);
    const span = xa.max - xa.min;
    const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
    let newSpan = span * factor;
    if (newSpan < MIN_WINDOW_S) newSpan = MIN_WINDOW_S;
    if (newSpan > 1e6) newSpan = 1e6;
    const left = t0 - (t0 - xa.min) * factor;
    const right = left + newSpan;
    applyXRange({ min: left, max: right });
  });
  // 拖拽平移
  let dragStart = null, dragStartRange = null;
  holder.addEventListener("mousedown", e => {
    if (playState.playing) return;
    dragStart = e.clientX;
    const xa = chart.scales.x;
    dragStartRange = { min: xa.min, max: xa.max };
  });
  window.addEventListener("mouseup", () => { dragStart = null; dragStartRange = null; });
  holder.addEventListener("mousemove", e => {
    if (dragStart != null && dragStartRange) {
      const xa = chart.scales.x;
      const rect = canvas.getBoundingClientRect();
      const dx = (e.clientX - dragStart) / rect.width * (dragStartRange.max - dragStartRange.min);
      applyXRange({ min: dragStartRange.min - dx, max: dragStartRange.max - dx });
    }
  });
  return chart;
}

/* 缩放/平移应用:全窗口同步(播放中由 draw 固定,禁止)。x 范围钳制 [0, 时长] 防负值 */
function applyXRange(range, src) {
  if (playState.playing) return;
  const dur = (state.stats && state.stats.duration_s) ? state.stats.duration_s : 46.1;
  let lo = Math.max(0, range.min);
  let hi = Math.min(dur, range.max);
  if (hi - lo < MIN_WINDOW_S) {   // 限窗兜底(钳制后跨度不足则对齐)
    if (lo === 0) hi = Math.min(dur, MIN_WINDOW_S);
    else if (hi >= dur) lo = Math.max(0, dur - MIN_WINDOW_S);
    else { hi = lo + MIN_WINDOW_S; }
  }
  syncingX = true;
  state.xRange = { min: lo, max: hi };
  state.plots.forEach(p => {
    if (!p.chart) return;
    p.chart.options.scales.x.min = lo;
    p.chart.options.scales.x.max = hi;
    p.chart.update("none");
  });
  syncingX = false;
  renderOverlays();
  scheduleLazyLoad();   // 停止后缩放 → 按需懒加载未解码窗口
}

/* ---------- 全部显示:索引就绪后静态全量渲染(不播放) ---------- */
async function showAllData() {
  if (!state.stats) { showTip("⏳ 索引未就绪,请等待构建完成后再试"); return; }
  const dur = state.stats.duration_s || 0;
  if (!dur) { showTip("无数据"); return; }
  showTip("加载全部数据…(索引就绪,秒级)");
  let ok = 0;
  for (const s of state.signals) {
    try {
      const q = `dbc=${encodeURIComponent(s.dbc || "")}&frame_id=${s.frame_id}&signal=${encodeURIComponent(s.signal)}&channel=${s.channel}&start=0&end=${dur}`;
      const d = await api(`/api/blf/${encodeURIComponent(state.blf)}/decode?${q}`);
      // ⚠️ decode 返回绝对时间戳 → 转相对(前端 x 轴 0-duration)
      s.winData = { times: (d.times || []).map(t => t - state.t0), values: d.values || [] };
      ok++;
    } catch (e) {
      showTip(`加载 ${s.signal} 失败: ${e.message}`);
    }
  }
  if (ok) {
    draw();
    showTip(`已显示全部数据(${ok} 个信号,静态查看;点播放切换动态)`);
  }
}

/* ---------- 批次3:缩放懒加载 ---------- */
/* 停止后缩放:窗口超出已解码范围 → 按需 decode 该窗口(相对秒),替换显示 */
let lazyTimer = null;
function scheduleLazyLoad() {
  clearTimeout(lazyTimer);
  lazyTimer = setTimeout(loadVisibleWindow, 300);
}

async function loadVisibleWindow() {
  if (playState.playing || !state.xRange || !state.signals.length) return;
  const { min, max } = state.xRange;
  for (const s of state.signals) {
    // 已解码覆盖范围:播放累积 s.data 的末时间(相对秒)
    const t = s.data.times;
    const coverEnd = t.length ? t[t.length - 1] : 0;
    if (max <= coverEnd + 0.05) continue;   // 窗口在已解码范围内 → 用播放数据
    if (!s.dbc) continue;
    const dbc = encodeURIComponent(s.dbc);
    const url = `/api/blf/${encodeURIComponent(state.blf)}/decode?dbc=${dbc}` +
      `&frame_id=${s.frame_id}&signal=${encodeURIComponent(s.signal)}&channel=${s.channel}` +
      `&start=${min.toFixed(3)}&end=${max.toFixed(3)}&max_points=200000`;
    try {
      const d = await api(url);
      if (!d.times || !d.times.length) { s.winData = { times: [], values: [] }; continue; }
      s.winData = { times: d.times.map(t => t - state.t0), values: d.values };
      draw();
    } catch (e) { /* 网络/解析失败静默,下次缩放重试 */ }
  }
}

/* overlay 重绘:锚点红线/同步竖线/抖动标记 → 触发各窗口 plugin 重绘 */
function renderOverlays() {
  state.plots.forEach(p => { if (p.chart) p.chart.update("none"); });
}

/* 单窗口数据与 datasets 同步(信号增删/数据更新)。重建 datasets(数量少,便宜) */
function updateSeriesData(p) {
  const sigs = p.sigs;
  const ds = [];
  sigs.forEach(s => {
    // 批次3 数据源:播放中 → 播放累积;停止后 → 懒加载窗口(若有)否则播放数据
    const src = playState.playing ? s.data : (s.winData || s.data);
    // ⚠️ 渲染限点:数据量大(播放到长日志 17 万点+)Chart.js 每帧重绘卡死 → 均匀抽稀到 ≤2 万点
    const t = src.times, v = src.values;
    const MAX_RENDER = 20000;
    const step = t.length > MAX_RENDER ? (t.length - 1) / (MAX_RENDER - 1) : 1;
    const data = [];
    for (let i = 0; i < t.length; i += Math.max(1, Math.floor(step))) {
      const raw = v[i];
      const val = (raw != null && typeof raw === "object" && "value" in raw) ? raw.value : raw;
      if (val == null) continue;
      data.push({ x: t[i], y: val });
    }
    ds.push({
      label: s.signal,
      data,
      choices: s.choices || null,          // 值表信号:tooltip 显示名称
      borderColor: s.color,
      backgroundColor: s.color,
      borderWidth: s.choices ? 1 : 2,
      pointRadius: 0,
      pointHitRadius: 8,
      stepped: s.choices ? "before" : false,   // 值表信号阶梯线
      parsing: false,
      spanGaps: false,
      tension: 0,
    });
  });
  p.chart.data.datasets = ds;
  const key = sigs.map(s => s.data.times.length + ":" + s.slot).join(",");
  if (key !== p._dkey) {
    p._dkey = key;
    applyXRangeNow(p);
    const _u0 = performance.now();
    p.chart.update("none");
    diagTime.lastUpdate = performance.now() - _u0;
  }
}

/* x 范围:播放固定全量(playState.dur)/ state.xRange / 静态全量(stats.duration_s) */
function applyXRangeNow(p) {
  const xa = p.chart.options.scales.x;
  if (state.xRange) {
    xa.min = state.xRange.min; xa.max = state.xRange.max;
  } else if (playState.dur > 0) {
    xa.min = 0; xa.max = playState.dur;
  } else {
    const dur = (state.stats && state.stats.duration_s) ? state.stats.duration_s : 1;
    xa.min = 0; xa.max = dur;
  }
}

/* 单个示波器的数据与实例(Chart.js 版) */
function updatePlotData(p) {
  const sigs = p.sigs;
  // 标题:示波器号 + 色点 + 信号名(带删除 ✕)
  p.title.innerHTML = `<span style="color:#4da3ff;font-weight:600">示波器 ${p.id}</span>` +
    `<button class="btn-mini plot-add" onclick="openAddSignal(${p.id})" title="向此示波器添加信号">+ 信号</button>` +
    sigs.map(s => `<span class="plot-sig" style="color:${s.color}">● ${s.signal}` +
      `<a href="javascript:void 0" onclick="removeSignalFromPlot(${p.id},${s.slot})" title="从示波器移除" style="margin-left:6px;color:#f87171;font-weight:700;text-decoration:none">✕</a></span>`).join("") +
    (sigs.length ? `<span class="plot-cnt">${sigs.length} 信号</span>` : `<span class="plot-empty">空示波器</span>`);
  if (!sigs.length) {
    if (p.chart) { p.chart.destroy(); p.chart = null; }
    p.canvasEl.innerHTML = `<div class="plot-empty-hint">点击 <b>+ 信号</b> 或左侧信号树选择信号</div>`;
    return;
  }
  if (!p.chart) createPlotChart(p);
  updateSeriesData(p);
  renderOverlays();
}

/* 光标移动:读数 + 同步竖线 + tooltip 由 Chart.js 内置 */
function onPlotHover(p, e) {
  const xa = p.chart.scales.x;
  const t = xa.getValueForPixel(e.x);
  if (t == null || !isFinite(t)) return;
  state.lastCursorT = t;
  // 所有已选信号读数(跨示波器):从各自所在窗口的 dataset 取最近值,时间同步
  state.signals.forEach(s => {
    const pp = state.plots.find(x => x.id === s.plotId);
    const ds = (pp && pp.chart) ? pp.chart.data.datasets.find(d => d.label === s.signal) : null;
    const val = ds ? nearestVal(ds, t) : null;
    const valEl = document.getElementById(`sigval-${s.slot}`);
    if (valEl) valEl.textContent = fmtSigValUnit(s, val);
  });
  // 锚点 Δt
  if (state.anchorT != null) showAnchorTip();
  // 同步竖线:所有窗口(含本窗口)
  state.plots.forEach(pp => {
    if (pp.chart) { pp.syncX = t; pp.chart.update("none"); }
  });
}

/* dataset 最近邻取值 */
function nearestVal(ds, t) {
  const d = ds.data;
  if (!d || !d.length) return null;
  let lo = 0, hi = d.length - 1;
  if (t <= d[0].x) return d[0].y;
  if (t >= d[hi].x) return d[hi].y;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (d[m].x <= t) lo = m; else hi = m; }
  return (t - d[lo].x < d[hi].x - t) ? d[lo].y : d[hi].y;
}

/* tooltip 锚点信息(窗口内) */
function showAnchorTip() {
  if (state.anchorT == null || state.lastCursorT == null) return;
  const dt = Math.abs(state.lastCursorT - state.anchorT);
  const f = dt > 0 ? (1 / dt).toFixed(1) : "∞";
  showTip(`锚点 ${state.anchorT.toFixed(3)}s · Δ${dt.toFixed(3)}s (${f} Hz)`);
}
function hideAnchorTip() { /* tooltip 由后续操作覆盖 */ }

/* 图表尺寸:Chart.js responsive 自动跟随容器,无手动逻辑 */
function resizeChart() {
  state.plots.forEach(p => { if (p.chart) p.chart.resize(); });
  renderOverlays();
}

function drawerOpen() {
  return document.getElementById("config-drawer").classList.contains("open");
}

/* 右侧配置抽屉展开/收起(点击边缘把手;展开时挤压主区域) */
function toggleConfigDrawer() {
  document.getElementById("config-drawer").classList.toggle("open");
  setTimeout(resizeChart, 280);   // 主区域宽度变化 → 同步图表
}

/* 左侧信号树展开/收起(与右侧配置抽屉对称) */
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  sb.classList.toggle("collapsed");
  setTimeout(resizeChart, 280);   // 主区域宽度变化 → 同步图表
}

async function fillConfig() {
  const cfg = state.config || {};
  document.getElementById("cfg-bus-type").value = cfg.bus_type || "canfd";
  const arb = document.getElementById("cfg-baud-arb");
  const data = document.getElementById("cfg-baud-data");
  arb.value = String(cfg.baudrate_arb || 500000);
  if (![...arb.options].some(o => o.value === arb.value)) arb.value = "500000";
  data.value = String(cfg.baudrate_data || 2000000);
  if (![...data.options].some(o => o.value === data.value)) data.value = "2000000";
  syncBusTypeUI();
  // 文件下拉(容错:api 失败时下拉为空列表而非中断填充)
  let files = [];
  try {
    ({ files } = await api("/api/files"));
  } catch (e) { files = []; }
  const blfSel = document.getElementById("cfg-blf");
  blfSel.innerHTML = '<option value="">— 请选择 —</option>' + files
    .filter(f => f.kind === ".blf")
    .map(f => `<option value="${f.name}">${f.name}</option>`).join("");
  blfSel.value = cfg.blf || state.blf || "";
  document.getElementById("cfg-jitter-mark").checked = showJitterMarks();   // 显示开关状态
  await refreshBlfViews(files);
  document.getElementById("config-tip").textContent = "";
}

/* 刷新配置抽屉:Bus Log 基本信息 + 通道 DBC 预览(按当前选中的 BLF,不依赖已保存配置) */
async function refreshBlfViews(files) {
  const blfName = document.getElementById("cfg-blf").value;
  const fileList = files || (await api("/api/files")).files;
  const dbcs = fileList.filter(f => f.kind === ".dbc");
  const infoBox = document.getElementById("blf-info");
  const chanBox = document.getElementById("cfg-channels");
  if (!blfName) {
    infoBox.innerHTML = "";
    chanBox.innerHTML = `<div class="hint">请选择 Bus Log 文件</div>`;
    return;
  }
  try {
    // ⚠️ 用 meta(零扫描秒回)而非 stats:删 cache 后 stats 返回 202(building)会渲染失败
    const st = await api(`/api/blf/${blfName}/meta`);
    const size = fileList.find(f => f.name === blfName)?.size || 0;
    const t0 = st.start_timestamp;
    infoBox.innerHTML =
      `<div>帧数 <b>${(st.frames || 0).toLocaleString()}</b> · 时长 <b>${(st.duration_s || 0).toFixed(2)} s</b> · 通道 <b>${(st.channels || []).length}</b></div>` +
      `<div>大小 <b>${(size / 1048576).toFixed(1)} MB</b> · 开始 <b>${t0 ? new Date(t0 * 1000).toLocaleString() : "—"}</b></div>` +
      (st.index_cached === false ? `<div class="blf-err">⏳ 索引后台构建中,统计/信号树稍后补齐</div>` : "");
    // 通道预览:按当前选中 BLF 的通道渲染;未保存的新选择 → 映射视为空(待重新配置)
    const blfChanged = blfName !== (state.config.blf || null);
    const chanCfg = blfChanged ? {} : (state.config.channels || {});
    const chansRaw = st.channels || [];
    const chans = (chansRaw.length && typeof chansRaw[0] === "object") ? chansRaw
      : chansRaw.map(c => ({ channel: c, frames: 0 }));
    renderChanList(chans, chanCfg, dbcs);
  } catch (e) {
    infoBox.innerHTML = `<span class="blf-err">解析失败: ${e.message}</span>`;
    chanBox.innerHTML = `<div class="hint">解析失败</div>`;
  }
}

/* 渲染通道 DBC 下拉列表 */
function renderChanList(chans, chanCfg, dbcs) {
  const box = document.getElementById("cfg-channels");
  if (!chans.length) {
    box.innerHTML = `<div class="hint">该文件无通道数据</div>`;
    return;
  }
  box.innerHTML = chans.map(ch => {
    const cur = chanCfg[String(ch.channel)] || "";
    const optsHtml = '<option value="">— DBC —</option>' + dbcs.map(d =>
      `<option value="${d.name}" ${d.name === cur ? "selected" : ""}>${d.name}</option>`).join("");
    return `<div class="chan-row">
      <span class="chan-tag">CH${ch.channel}</span>
      <span class="chan-frames">${ch.frames.toLocaleString()} 帧</span>
      <select data-chan="${ch.channel}">${optsHtml}</select>
    </div>`;
  }).join("");
}

function syncBusTypeUI() {
  const isFd = document.getElementById("cfg-bus-type").value === "canfd";
  document.getElementById("row-baud-data").style.display = isFd ? "" : "none";
}

async function saveConfig() {
  const tip = document.getElementById("config-tip");
  // 收集每通道 DBC 映射
  const channels = {};
  document.querySelectorAll("#cfg-channels select[data-chan]").forEach(s => {
    if (s.value) channels[s.dataset.chan] = s.value;
  });
  const blfChanged = document.getElementById("cfg-blf").value !== (state.config.blf || null);
  const payload = {
    bus_type: document.getElementById("cfg-bus-type").value,
    baudrate_arb: parseInt(document.getElementById("cfg-baud-arb").value, 10),
    baudrate_data: parseInt(document.getElementById("cfg-baud-data").value, 10),
    blf: document.getElementById("cfg-blf").value || null,
    // ⚠️ 始终用表单中的通道映射(不再因 BLF 变更清空:用户常在同一次配置里选 BLF+配 DBC,
    // 清空会导致第一次保存丢映射、要点两次才刷新树;新 BLF 不存在的通道由 loadFiles 自然忽略)
    channels,
  };
  if (!payload.blf) {
    tip.textContent = "请选择 Bus Log 文件";
    return;
  }
  try {
    state.config = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    document.getElementById("config-drawer").classList.remove("open");  // 保存后缩回
    if (blfChanged) {
      await loadFiles();   // BLF 变了 → 全量重新加载(重扫 stats,大文件会弹进度遮罩)
    } else {
      // 仅通道 DBC 映射变化:轻量重建通道映射 + 信号树(不重扫 stats,避免大文件重复弹"正在处理")
      const chanCfg = state.config.channels || {};
      state.channels = state.channels.map(c => ({
        ...c, dbc: chanCfg[String(c.channel)] || null, messages: null,
      }));
      await loadDbcTree();
    }
    showTip("配置已保存并应用");
  } catch (e) {
    tip.textContent = "保存失败: " + e.message;
  }
}

/* ---------- 数据加载 ---------- */
/* stats:有缓存秒回;无缓存 202 → 后台构建(不阻塞,轮询补全后 applyStats) */
async function loadStats(name) {
  try {
    const r = await fetch(`/api/blf/${encodeURIComponent(name)}/stats`);
    if (r.status === 202) {
      pollStatsUntilReady(name);   // 非阻塞:后台构建完成自动补全
      return null;
    }
    return await r.json();
  } catch (e) {
    pollStatsUntilReady(name);     // 网络抖动 → 也走轮询
    return null;
  }
}
async function pollStatsUntilReady(name) {
  for (let i = 0; i < 900; i++) {   // 最多 15 分钟
    await new Promise(res => setTimeout(res, 1000));
    try {
      const r = await fetch(`/api/blf/${encodeURIComponent(name)}/stats`);
      if (r.status !== 200) continue;
      applyStats(await r.json());
      return;
    } catch (e) { /* 重试 */ }
  }
}
/* stats 就绪 → 更新全局状态 + 信号树灰标 + 统计 */
function applyStats(st) {
  if (!st) return;
  state.stats = st;
  state.t0 = st.first_ts || st.first_timestamp || 0;
  const byId = st.by_id || {};
  state.hasData = new Set(Array.isArray(byId) ? byId.map(e => e.frame_id) : Object.keys(byId).map(Number));
  document.getElementById("st-frames").textContent = `帧数 ${st.total_frames}`;
  document.getElementById("st-duration").textContent = `时长 ${st.duration_s.toFixed(1)} s`;
  document.getElementById("st-ids").textContent = `报文数 ${st.unique_ids}`;
  loadDbcTree();   // 刷新信号树灰标(报文级)
  if (currentTab() === "stats") renderStats();
}

async function loadFiles() {
  const { files } = await api("/api/files");
  const blfs = files.filter(f => f.kind === ".blf");
  const dbcs = files.filter(f => f.kind === ".dbc");
  // 优先用配置指定的 Bus Log,否则取第一个
  const cfg = state.config || {};
  state.blf = (cfg.blf && blfs.find(f => f.name === cfg.blf)) ? cfg.blf : (blfs[0]?.name || null);
  if (!state.blf) throw new Error("缺少 BLF 文件,请先上传");
  document.getElementById("file-blf").textContent = "Bus Log: " + state.blf;
  document.getElementById("file-dbc").textContent = `DBC 已上传: ${dbcs.length} 个`;

  // 重置分析状态(文件可能已切换)
  state.signals = [];
  state.plots.forEach(p => { if (p.chart) p.chart.destroy(); });
  state.plots = [];
  state.plotIds = [];
  state.plotSeq = 1;
  state.xRange = null;
  document.getElementById("plot-wrap").innerHTML = "";
  hideCursorTip();
  document.getElementById("busload-box").dataset.loaded = "";   // 文件切换 → Bus Load 重新加载
  state.trace = { frameId: null, channel: null, offset: 0, limit: 200, search: null, range: null };

  // ① meta 零扫描秒回:通道列表 + 基本信息(不依赖全扫,大文件不弹处理弹窗)
  let meta = null;
  try {
    meta = await api(`/api/blf/${encodeURIComponent(state.blf)}/meta`);
  } catch (e) { /* 无缓存时 meta 内部已触发后台构建 */ }
  const chanCfg = state.config.channels || {};
  const rawCh = (meta && meta.channels) || [];
  state.channels = (rawCh.length ? rawCh : [0]).map(c => ({
    channel: c, frames: 0, dbc: chanCfg[String(c)] || null, messages: null,
  }));
  if (meta) {
    document.getElementById("st-frames").textContent = `帧数 ${meta.frames}`;
    document.getElementById("st-duration").textContent = `时长 ${meta.duration_s.toFixed(1)} s`;
    document.getElementById("st-ids").textContent = "报文数 …";
    showTip(`日志: ${meta.duration_s.toFixed(1)} s · ${meta.channels.length} 通道${meta.index_cached ? "" : "(后台构建索引中…)"}`);
  }
  // ② 信号树先用 meta 通道加载(DBC 报文树;灰标等 stats 完成补齐)
  await loadDbcTree();
  // ③ stats:缓存秒回;无缓存 202 → 后台构建(提示条可见),完成自动 applyStats
  const st0 = await loadStats(state.blf);
  if (st0) applyStats(st0);
  else if (meta) { state.t0 = meta.start_timestamp || 0; }
  if (!state.stats) { state.stats = meta ? { duration_s: meta.duration_s, total_frames: meta.frames, unique_ids: 0, by_id: {} } : {}; }
  if (state.stats && state.stats.by_id) {
    if (currentTab() === "stats") renderStats();
  }
}

async function loadDbcTree() {
  const tree = document.getElementById("msg-tree");
  tree.innerHTML = "";
  const sel = document.getElementById("trace-msg");
  sel.innerHTML = '<option value="">— 选择报文 —</option>';

  // 并行加载各通道 DBC 的报文列表
  await Promise.all(state.channels.map(async (ch) => {
    if (!ch.dbc) { ch.messages = []; return; }
    try {
      const { messages } = await api(`/api/dbc/${ch.dbc}/messages`);
      ch.messages = messages;
    } catch (e) {
      ch.messages = [];
      ch.error = e.message;
    }
  }));

  for (const ch of state.channels) {
    const g = document.createElement("div");
    g.className = "chan-group";
    const head = document.createElement("div");
    head.className = "chan-head";
    head.innerHTML = `<span class="caret">▸</span><span class="chan-head-title">通道 ${ch.channel}</span>
      <span class="chan-head-info">${ch.frames.toLocaleString()} 帧</span>
      <span class="chan-head-dbc" title="${ch.dbc || "未配置 DBC"}">${ch.dbc || "未配置 DBC"}</span>`;
    head.onclick = () => {
      const list = g.querySelector(".chan-body");
      const show = list.style.display === "none";
      list.style.display = show ? "" : "none";
      head.querySelector(".caret").textContent = show ? "▾" : "▸";
    };
    g.appendChild(head);

    const body = document.createElement("div");
    body.className = "chan-body";
    if (!ch.messages.length) {
      body.innerHTML = `<div class="hint">${ch.error ? "DBC 加载失败: " + ch.error :
        (ch.dbc ? "该 DBC 无报文" : "未配置 DBC,请在右侧配置中为该通道选择 DBC 文件")}</div>`;
    }
    for (const m of ch.messages) {
      // Trace 下拉:选项值 = "frameId|channel"
      const opt = document.createElement("option");
      opt.value = `${m.frame_id}|${ch.channel}`;
      opt.textContent = `CH${ch.channel} ${m.frame_id_hex} ${m.name}`;
      sel.appendChild(opt);
      const wrap = document.createElement("div");
      wrap.className = "msg-item";

      const mhead = document.createElement("div");
      mhead.className = "msg-head";
      const sender = (m.senders && m.senders.length) ? m.senders[0] : "";
      const senderTip = (m.senders || []).join(", ");
      const nc = sender ? nodeColor(sender) : "";
      mhead.innerHTML = `<span class="caret">▸</span>
        ${sender ? `<span class="msg-tag" style="background:${nc}26;border-color:${nc}55;color:${nc}" title="发送节点: ${senderTip}">${sender}</span>` : ""}
        <span class="msg-id">${m.frame_id_hex}</span>
        <span class="msg-name">${m.name}</span>
        <span class="msg-count">${m.signal_count} 信号</span>`;
      mhead.onclick = () => {
        const list = wrap.querySelector(".sig-list");
        const show = list.style.display === "none";
        list.style.display = show ? "" : "none";
        mhead.querySelector(".caret").textContent = show ? "▾" : "▸";
      };
      // 日志中无此报文 → 灰色标记(点击信号时快速提示)
      if (state.hasData && !state.hasData.has(m.frame_id)) mhead.classList.add("no-data");
      wrap.appendChild(mhead);

      const list = document.createElement("div");
      list.className = "sig-list";
      list.style.display = "none";
      for (const s of m.signals) {
        const item = document.createElement("div");
        item.className = "sig-item";
        item.innerHTML = `<span class="sig-dot"></span> <span class="sig-name">${s}</span> <span class="sig-unit">${m.frame_id_hex}</span>`;
        // 信号树点击:添加/删除该信号(复用空示波器)
        item.onclick = () => toggleSignal(m, s, item, ch.channel);
        item.dataset.sig = s;
        item.dataset.ch = String(ch.channel);
        list.appendChild(item);
      }
      wrap.appendChild(list);
      body.appendChild(wrap);
    }
    g.appendChild(body);
    tree.appendChild(g);
  }
  document.getElementById("tree-hint")?.remove();

  // 恢复上次选择的信号(刷新保留);仅"首次使用(无记录)"才自动选默认信号
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_SIG) || "null"); } catch (e) { /* 忽略 */ }
  if (saved && saved.blf === state.blf) {
    if (saved.signals && saved.signals.length) {
      const n = await restoreSelectedSignals();
      if (n > 0) showTip(`已恢复上次选择的 ${n} 个信号`);
    }
    return;
  }
  // 首次使用(无记录)→ 自动选中第一个有数据的报文前两个信号
  const firstCh = state.channels.find(c => c.messages && c.messages.length);
  if (firstCh) {
    const m0 = state.hasData
      ? firstCh.messages.find(m => state.hasData.has(m.frame_id)) : null;
    const items = Array.from(document.querySelectorAll(".chan-group .sig-item"));
    const findItem = (sig) => items.find(el =>
      el.dataset.sig === sig &&
      el.dataset.ch === String(firstCh.channel) &&
      el.closest(".msg-item")?.querySelector(".msg-id")?.textContent === m0.frame_id_hex);
    if (m0 && m0.signals.length >= 2) {
      toggleSignal(m0, m0.signals[0], findItem(m0.signals[0]), firstCh.channel);
      toggleSignal(m0, m0.signals[1], findItem(m0.signals[1]), firstCh.channel);
    } else if (m0 && m0.signals.length > 0) {
      toggleSignal(m0, m0.signals[0], findItem(m0.signals[0]), firstCh.channel);
    }
  }

  // 初始化 Trace 面板
  onTraceMsgChange();
}

/* ECU 节点标签调色板:同一节点始终同色 */
const NODE_COLORS = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff",
                     "#4dd6c8", "#f472b6", "#a3e635", "#fb923c", "#60a5fa"];
function nodeColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NODE_COLORS[h % NODE_COLORS.length];
}

/* 信号树搜索:按报文 ID(hex)/报文名/发送 ECU/信号名实时过滤 */
function filterTree(q) {
  q = (q || "").trim().toLowerCase();
  const qHex = q.replace(/^0x/, "");
  document.querySelectorAll(".chan-group").forEach(g => {
    let groupVisible = false;
    g.querySelectorAll(".msg-item").forEach(item => {
      const head = item.querySelector(".msg-head");
      const idTxt = head.querySelector(".msg-id").textContent.toLowerCase();     // "0x21"
      const nameTxt = head.querySelector(".msg-name").textContent.toLowerCase();
      const sigList = item.querySelector(".sig-list");
      const caret = head.querySelector(".caret");

      let msgMatch = false;
      let sigMatch = false;
      if (!q) {
        msgMatch = true;
      } else {
        const senderTxt = head.querySelector(".msg-tag")?.textContent.toLowerCase() || "";
        msgMatch = idTxt.includes(q) || idTxt.replace("0x", "").includes(qHex) ||
                   nameTxt.includes(q) || senderTxt.includes(q);
        // 信号匹配:显示命中的信号项
        sigList.querySelectorAll(".sig-item").forEach(si => {
          const sn = si.querySelector(".sig-name").textContent.toLowerCase();
          const hit = sn.includes(q);
          si.style.display = hit ? "" : "none";
          if (hit) sigMatch = true;
        });
      }

      const show = !q || msgMatch || sigMatch;
      item.style.display = show ? "" : "none";
      if (show) {
        if (q && sigMatch && !msgMatch) {
          // 只有信号命中 → 展开信号列表展示匹配项
          sigList.style.display = "";
          caret.textContent = "▾";
        } else if (!q) {
          // 清空搜索 → 恢复默认折叠
          sigList.style.display = "none";
          caret.textContent = "▸";
        }
        groupVisible = true;
      }
    });
    g.style.display = groupVisible ? "" : "none";
    g.querySelector(".chan-body").style.display = groupVisible ? "" : "none";
    g.querySelector(".chan-head .caret").textContent = groupVisible ? "▾" : "▸";
  });
}

/* 信号树排序:按 frame ID 或发送 ECU */
let treeSortMode = "id";
function toggleTreeSort() {
  treeSortMode = treeSortMode === "id" ? "ecus" : "id";
  document.getElementById("tree-sort").textContent =
    treeSortMode === "id" ? "排序: ID" : "排序: ECU";
  sortTree();
}
function sortTree() {
  const mode = treeSortMode;
  document.querySelectorAll(".chan-group .chan-body").forEach(body => {
    const items = Array.from(body.querySelectorAll(".msg-item"));
    items.sort((a, b) => {
      const idA = parseInt(a.querySelector(".msg-id").textContent, 16);
      const idB = parseInt(b.querySelector(".msg-id").textContent, 16);
      if (mode === "ecus") {
        const ea = (a.querySelector(".msg-tag")?.textContent || "").toLowerCase();
        const eb = (b.querySelector(".msg-tag")?.textContent || "").toLowerCase();
        if (ea !== eb) return ea < eb ? -1 : 1;
      }
      return idA - idB;
    });
    items.forEach(it => body.appendChild(it));
  });
  // 排序后重新应用当前搜索
  filterTree(document.getElementById("tree-search").value);
}

/* 核心:添加信号到指定示波器(plotId 为 null 时自动复用空示波器) */
async function addSignal(msg, signal, channel, plotId) {
  pausePlayOnSignalChange();   // 播放中加信号 → 自动暂停
  // 先确定示波器:指定则用;未指定则复用空示波器,无空才新建
  let pid = plotId;
  if (pid == null) {
    const usedPlotIds = new Set(state.signals.map(s => s.plotId));
    const emptyPlot = state.plotIds.find(id => !usedPlotIds.has(id));
    pid = emptyPlot != null ? emptyPlot : state.plotSeq++;
    if (emptyPlot == null) state.plotIds.push(pid);
  }
  // 同一信号可显示在不同示波器;仅"同一信号 + 同一示波器"才算重复
  const existing = state.signals.find(s => s.signal === signal && s.frame_id === msg.frame_id && s.channel === channel && s.plotId === pid);
  if (existing) {
    showTip(`信号已显示在示波器 ${pid}`);
    return false;
  }
  if (state.signals.length >= MAX_SERIES) {
    showTip(`最多同时显示 ${MAX_SERIES} 个信号`);
    return false;
  }
  const used = new Set(state.signals.map(s => s.color));
  const color = PALETTE.find(c => !used.has(c)) || PALETTE[state.signals.length % PALETTE.length];

  const ch = state.channels.find(c => c.channel === channel);
  const dbc = ch && ch.dbc;
  if (!dbc) {
    showTip(`通道 ${channel} 未配置 DBC,请在右侧配置中为该通道选择 DBC 文件`);
    return false;
  }
  if (state.hasData && !state.hasData.has(msg.frame_id)) {
    showTip(`报文 ${msg.frame_id_hex} 在日志中无数据(该通道未发送),无法画曲线`);
    return false;
  }

  let detail;
  try {
    detail = await api(`/api/dbc/${dbc}/messages/${msg.frame_id_hex}`);
  } catch (e) {
    showTip(`加载失败: ${e.message}`);
    return false;
  }
  // 批次3:选信号仅订阅(不画曲线),曲线在播放时边解码边出现;缩放未解码区域按需懒加载
  const sigDef = detail.signals.find(s => s.name === signal);
  const unit = sigDef?.unit || "";
  const choices = sigDef?.choices || null;    // 值表信号:读数显示名称
  const comment = sigDef?.comment || "";      // 信号说明文字
  const senders = detail.senders || [];       // 发送 ECU

  const data = { times: [], values: [] };   // 仅订阅:播放时填充
  const usedSlots = new Set(state.signals.map(s => s.slot));
  const slot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
                31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
                45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
                59, 60, 61, 62, 63, 64].find(i => !usedSlots.has(i));
  state.signals.push({ frame_id: msg.frame_id, signal, unit, color, slot, data, channel, dbc, choices, comment, senders, plotId: pid,
    winData: null });   // winData:停止后缩放懒加载的窗口数据
  saveSelectedSignals();
  draw();
  if (currentTab() === "sigstats") loadSigStats();
  return true;
}

/* 向指定示波器添加信号(示波器内入口调用) */
/* 从已选信号复制到指定示波器(复用已解码数据,免 API) */
function addSignalFromSignal(src, plotId) {
  const existing = state.signals.find(s => s.frame_id === src.frame_id && s.signal === src.signal && s.channel === src.channel && s.plotId === plotId);
  if (existing) { showTip(`信号已显示在示波器 ${plotId}`); return false; }
  if (state.signals.length >= MAX_SERIES) { showTip(`最多同时显示 ${MAX_SERIES} 个信号`); return false; }
  const usedSlots = new Set(state.signals.map(s => s.slot));
  const slot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
    49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64].find(i => !usedSlots.has(i));
  state.signals.push({ ...src, slot, plotId });
  saveSelectedSignals();
  draw();
  if (currentTab() === "sigstats") loadSigStats();
  return true;
}

/* 示波器内添加信号:从已选信号复制(按 slot 找源条目) */
function addSignalToPlot(plotId, slot) {
  const src = state.signals.find(s => s.slot === slot);
  if (!src) return;
  const ok = addSignalFromSignal(src, plotId);
  if (ok) closeAddSignal();
}

/* 示波器内添加信号:模态选择器 */
let addingPlot = null;
function openAddSignal(plotId) {
  addingPlot = plotId;
  document.getElementById("add-target").textContent = plotId;
  document.getElementById("add-search").value = "";
  document.getElementById("add-signal-modal").style.display = "";
  renderAddSignalList("");
}
function closeAddSignal() {
  addingPlot = null;
  document.getElementById("add-signal-modal").style.display = "none";
}
function renderAddSignalList(q) {
  const box = document.getElementById("add-signal-list");
  box.innerHTML = "";
  const ql = (q || "").toLowerCase();
  if (!state.signals.length) {
    box.innerHTML = `<div class="hint">已选信号列表为空<br>先在左侧信号树点选信号,再到这里分配到示波器</div>`;
    return;
  }
  // 数据源:已选信号列表(按 frame_id+signal+channel 去重;同信号可分配到多个示波器)
  const seen = new Set();
  const items = [];
  for (const s of state.signals) {
    const key = `${s.frame_id}|${s.signal}|${s.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(s);
  }
  const matched = items.filter(s =>
    !ql ||
    s.signal.toLowerCase().includes(ql) ||
    ("0x" + s.frame_id.toString(16)).includes(ql) ||
    (s.unit || "").toLowerCase().includes(ql));
  for (const s of matched) {
    const where = state.signals
      .filter(ss => ss.frame_id === s.frame_id && ss.signal === s.signal && ss.channel === s.channel)
      .map(ss => `示波器 ${ss.plotId}`).join("、");
    const here = state.signals.some(ss =>
      ss.frame_id === s.frame_id && ss.signal === s.signal && ss.channel === s.channel && ss.plotId === addingPlot);
    const row = document.createElement("div");
    row.className = "add-sig";
    row.innerHTML = `<span class="sig-dot" style="background:${s.color}"></span>
      <span class="sig-name">${s.signal}</span>
      <span class="dim">${where ? `已在 ${where}` : ""}</span>
      ${here ? `<span class="nodata-tag">已在此示波器</span>` : ""}`;
    if (!here) row.onclick = () => addSignalToPlot(addingPlot, s.slot);
    box.appendChild(row);
  }
  if (!box.children.length) box.innerHTML = `<div class="hint">无匹配信号</div>`;
}

/* 信号树点击切换:三元组增删(同信号在多示波器时点击树 = 移除所有该信号) */
async function toggleSignal(msg, signal, item, channel) {
  pausePlayOnSignalChange();   // 播放中改信号 → 自动暂停
  const dups = state.signals.filter(s => s.signal === signal && s.frame_id === msg.frame_id && s.channel === channel);
  if (dups.length) {
    state.signals = state.signals.filter(s => !(s.signal === signal && s.frame_id === msg.frame_id && s.channel === channel));
    if (item) item.classList.remove("active");
    saveSelectedSignals();
    draw();
    if (currentTab() === "sigstats") loadSigStats();
    return;
  }
  if (item) item.classList.add("active");
  const ok = await addSignal(msg, signal, channel, null);
  if (!ok && item) item.classList.remove("active");
}

/* ---------- 管理 ---------- */
/* 强制重启后台服务:POST /api/admin/restart(后端延时换进程)→ 提示 → 自动刷新 */
/* 清空索引缓存(测试/重新构建):调后端清缓存 + 提示 + 刷新页面 */
async function clearCache() {
  if (!confirm("清空全部索引缓存?下次访问将重新构建(大文件较慢,有进度提示)")) return;
  try {
    const d = await api("/api/admin/clear-cache", { method: "POST" });
    showTip(`已清空 ${d.cleared} 个缓存文件,刷新后重新构建`);
  } catch (e) {
    showTip(`清空失败: ${e.message}`);
    return;
  }
  setTimeout(() => location.reload(), 1200);
}

async function restartBackend() {
  if (!confirm("确定重启后台服务?\n页面将短暂断开,已上传的文件保留。")) return;
  showTip("正在重启后台…");
  try {
    await fetch("/api/admin/restart", { method: "POST" });
  } catch (e) { /* 重启期间连接会断,忽略 */ }
  setTimeout(() => {
    showTip("重启完成,刷新页面…");
    location.reload();
  }, 4000);
}

/* ---------- 导出 ---------- */
document.getElementById("btn-export").onclick = () => {
  if (!state.signals.length) {
    showTip("请先选择至少一个信号");
    return;
  }
  const s = state.signals[0];
  const q = new URLSearchParams({
    dbc: s.dbc,
    frame_id: "0x" + s.frame_id.toString(16),
    channel: String(s.channel),
  });
  // 缩放区间导出:示波器有缩放时,只导出当前 x 轴范围(时间同步,取任一示波器)
  const p0 = state.plots.find(x => x.chart);
  if (p0) {
    const xa = p0.chart.options.scales.x;
    if (xa && xa.min != null) {
      q.set("start", String(xa.min));
      q.set("end", String(xa.max));
    }
  }
  window.open(`/api/blf/${state.blf}/export?${q}`, "_blank");
  showTip("正在导出 CSV(按当前缩放区间)…");
};

document.getElementById("btn-reset").onclick = () => {
  state.xRange = null;
  state.plots.forEach(p => {
    if (!p.chart) return;
    const dur = (state.stats && state.stats.duration_s) ? state.stats.duration_s : 1;
    p.chart.options.scales.x.min = 0;
    p.chart.options.scales.x.max = dur;
    p.chart.update("none");
  });
  renderOverlays();
};
// 用 ResizeObserver 观察图表容器:抽屉/信号树展开动画期间容器宽度逐帧变化,
// canvas 同步逐帧跟随 → 收缩丝滑无跳变(uPlot setSize 轻量,小数据无压力)
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(() => resizeChart());
  ro.observe(document.getElementById("plot-wrap"));
}
window.addEventListener("resize", () => resizeChart());   // 整窗缩放兜底

/* 已选信号列宽度拖拽调整 */
(function initSigResizer() {
  const resizer = document.getElementById("sig-resizer");
  const sidebar = document.getElementById("sig-sidebar");
  let drag = null;
  resizer.addEventListener("mousedown", (e) => {
    drag = { startX: e.clientX, startW: sidebar.offsetWidth };
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const w = Math.max(80, Math.min(320, drag.startW + (e.clientX - drag.startX)));
    sidebar.style.width = w + "px";
    // plot-wrap 宽度被 ResizeObserver 感知 → 曲线自动跟随
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    resizeChart();   // 兜底:确保曲线尺寸对齐
  });
})();

/* ---------- Trace 表格 ---------- */
function onTraceMsgChange() {
  const val = document.getElementById("trace-msg").value;
  if (!val) { state.trace.frameId = null; return; }
  const [fid, ch] = val.split("|");
  state.trace.frameId = parseInt(fid, 10);
  state.trace.channel = parseInt(ch, 10);
  state.trace.offset = 0;
  state.trace.search = null;
  fillTraceSig();
  document.getElementById("trace-sig-val").value = "";
  document.getElementById("trace-clear").style.display = "none";
  loadTrace();
}

/* 填充 Trace 搜索的信号下拉(当前报文的信号列表) */
function fillTraceSig() {
  const sel = document.getElementById("trace-sig");
  const ch = state.channels.find(c => c.channel === state.trace.channel);
  const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === state.trace.frameId) : null;
  sel.innerHTML = '<option value="">— 信号 —</option>' + (msg ? msg.signals
    .map(s => `<option value="${s}">${s}</option>`).join("") : "");
}

function doTraceSearch() {
  const signal = document.getElementById("trace-sig").value;
  const value = document.getElementById("trace-sig-val").value.trim();
  if (!signal || !value) {
    showTip("请选择信号并输入要搜索的值/状态名");
    return;
  }
  state.trace.search = { signal, value };
  state.trace.offset = 0;
  document.getElementById("trace-clear").style.display = "";
  loadTrace();
}

function clearTraceSearch() {
  state.trace.search = null;
  state.trace.offset = 0;
  document.getElementById("trace-sig-val").value = "";
  document.getElementById("trace-clear").style.display = "none";
  loadTrace();
}

/* 按示波器当前缩放区间过滤 Trace(读取 Chart.js x 范围) */
function applyTraceRange() {
  const p0 = state.plots.find(x => x.chart);
  if (!p0) { showTip("请先在示波器上缩放出区间"); return; }
  const xa = p0.chart.options.scales.x;
  if (!xa || xa.min == null) { showTip("请先在示波器上缩放出区间"); return; }
  state.trace.range = { start: xa.min, end: xa.max };
  state.trace.offset = 0;
  document.getElementById("trace-range-clear").style.display = "";
  loadTrace();
}
function clearTraceRange() {
  state.trace.range = null;
  state.trace.offset = 0;
  document.getElementById("trace-range-clear").style.display = "none";
  loadTrace();
}

async function loadTrace() {
  const fid = state.trace.frameId;
  const ch = state.trace.channel;
  if (fid == null) {
    document.getElementById("trace-body").innerHTML =
      `<tr><td colspan="6" class="hint">请选择报文</td></tr>`;
    return;
  }
  const body = document.getElementById("trace-body");
  body.innerHTML = `<tr><td colspan="6" class="hint">加载中…</td></tr>`;
  // 用该通道绑定的 DBC
  const chan = state.channels.find(c => c.channel === ch);
  const dbc = chan && chan.dbc;
  if (!dbc) {
    body.innerHTML = `<tr><td colspan="6" class="hint">通道 ${ch} 未配置 DBC,请先在右侧配置中设置</td></tr>`;
    return;
  }
  let url = `/api/blf/${state.blf}/frames?dbc=${encodeURIComponent(dbc)}` +
    `&frame_id=${fid}&channel=${ch}&limit=${state.trace.limit}&offset=${state.trace.offset}&decode=false`;
  if (state.trace.range) {
    url += `&start=${state.trace.range.start}&end=${state.trace.range.end}`;
  }
  if (state.trace.search) {
    url += `&sig_filter=${encodeURIComponent(state.trace.search.signal)}` +
           `&sig_value=${encodeURIComponent(state.trace.search.value)}`;
  }
  const r = await api(url);
  const info = document.getElementById("trace-info");
  if (state.trace.search) {
    info.innerHTML = `<span class="trace-search-on">🔍 ${state.trace.search.signal}=${state.trace.search.value}</span> · 匹配 ${state.trace.offset + 1}-${state.trace.offset + r.returned} 帧`;
  } else {
    info.textContent = `第 ${state.trace.offset + 1}-${state.trace.offset + r.returned} 帧`;
  }
  document.getElementById("trace-prev").disabled = state.trace.offset === 0;
  document.getElementById("trace-next").disabled = r.returned < state.trace.limit;

  body.innerHTML = "";
  for (const f of r.frames) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="t-time">${(f.timestamp - state.t0).toFixed(3)}</td>
      <td class="t-id">${f.id_hex}</td><td>${f.name}</td>
      <td>${f.dlc}${f.is_fd ? `<span class="fd-tag">FD</span>` : ""}</td>
      <td>CH${f.channel}</td>
      <td class="t-data">${f.data}</td>`;
    body.appendChild(tr);
  }
  if (!r.returned) body.innerHTML = `<tr><td colspan="6" class="hint">${state.trace.search ? "无匹配帧" : "无数据"}</td></tr>`;
}

function tracePage(dir) {
  state.trace.offset = Math.max(0, state.trace.offset + dir * state.trace.limit);
  loadTrace();
}

/* ---------- ID 统计 ---------- */
function renderStats() {
  const box = document.getElementById("stats-box");
  const byId2 = state.stats.by_id || {};
  const ids = Array.isArray(byId2) ? byId2 : Object.entries(byId2).map(([id, count]) => ({ frame_id: Number(id), count }));
  if (!ids.length) { box.innerHTML = `<div class="hint">无数据</div>`; return; }
  const max = Math.max(...ids.map(e => e.count));
  box.innerHTML = ids.map(e => {
    const hexId = e.frame_id_hex || "0x" + e.frame_id.toString(16);
    return `
    <div class="stat-row">
      <span class="stat-id">${hexId}</span>
      <div class="stat-bar-bg"><div class="stat-bar" style="width:${(e.count / max * 100).toFixed(1)}%"></div></div>
      <span class="stat-count">${e.count} 帧</span>
      <span class="stat-rate">${e.rate_hz != null ? e.rate_hz + " Hz" : "—"}</span>
    </div>`;
  }).join("");
}

/* ---------- 标签页 ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.getElementById("panel-trace").style.display = name === "trace" ? "" : "none";
  document.getElementById("panel-stats").style.display = name === "stats" ? "" : "none";
  document.getElementById("panel-sigstats").style.display = name === "sigstats" ? "" : "none";
  if (name === "trace" && !state.trace.frameId) onTraceMsgChange();
  if (name === "stats") { renderStats(); loadBusLoad(); }
  if (name === "sigstats") loadSigStats();
}

/* Bus Load 概览条(ID 统计 tab 顶部) */
async function loadBusLoad() {
  const box = document.getElementById("busload-box");
  if (box.dataset.loaded) return;
  try {
    const r = await api(`/api/blf/${state.blf}/bus-load`);
    const items = Object.entries(r.channels || {}).map(([ch, v]) =>
      `<div class="busload-item">通道 ${ch} <b>${v.bus_load_pct}%</b>
        <span class="dim">${v.frames.toLocaleString()} 帧 · 占用 ${v.bus_time_s}s/${v.duration_s}s</span></div>`).join("");
    box.innerHTML = `<div class="busload-item">总线负载 <b>${r.bus_type.toUpperCase()}</b>
        <span class="dim">仲裁 ${(r.arbitration_baudrate / 1000)}k · 数据 ${(r.data_baudrate / 1000)}k</span></div>` + items;
    box.dataset.loaded = "1";
  } catch (e) {
    box.innerHTML = `<div class="busload-item dim">Bus Load 加载失败: ${e.message}</div>`;
  }
}

/* ---------- 示波器高度三档 ---------- */
let chartMode = 1;   // 0=全部页面 1=2/3 页面 2=全部收缩
function cycleChartMode() {
  chartMode = (chartMode + 1) % 3;
  applyChartMode();
}
function applyChartMode() {
  const chart = document.getElementById("chart");
  const tabs = document.getElementById("tabs");
  const ind = document.getElementById("chart-mode-ind");
  const panelIds = ["panel-trace", "panel-stats", "panel-sigstats"];
  if (chartMode === 0) {
    // 全部页面:只有示波器
    chart.style.display = "";
    chart.style.flex = "1";
    chart.style.minHeight = "";
    tabs.style.display = "none";
    panelIds.forEach(id => document.getElementById(id).style.display = "none");
    ind.textContent = "▔ 全页";
    hideCursorTip();
  } else {
    chart.style.display = "";
    chart.style.minHeight = "";
    tabs.style.display = "";
    if (chartMode === 1) {
      chart.style.flex = "2";          // 示波器 2/3,面板 1/3
      ind.textContent = "▁▔ 2/3";
    } else {
      chart.style.flex = "0 1 0%";     // 全部收缩:示波器收起,面板占满
      chart.style.minHeight = "0";
      ind.textContent = "▁ 收起";
    }
    switchTab(currentTab());           // 恢复当前 tab 的面板显示
  }
  setTimeout(resizeChart, 60);         // 高度变化 → 同步 uPlot
}

/* 当前底部 tab */
function currentTab() {
  return document.querySelector("#tabs .tab.active")?.dataset.tab || "trace";
}

/* 信号统计 tab:已选信号的数值统计 + 所属报文周期/抖动/丢帧 */
async function loadSigStats() {
  const box = document.getElementById("sigstats-box");
  if (!state.signals.length) {
    box.innerHTML = `<div class="hint">请先选择信号(点击左侧信号树)</div>`;
    return;
  }
  box.innerHTML = `<div class="hint">加载中…</div>`;
  state.jitterMarks = [];   // 重建抖动峰值标记
  try {
    const ch = state.channels.find(c => c.channel === state.signals[0].channel);
    const dbc = (ch && ch.dbc) || state.signals[0].dbc;
    const rows = [];
    const msgCache = {};
    for (const s of state.signals) {
      const st = await api(`/api/blf/${state.blf}/signal-stats?dbc=${encodeURIComponent(dbc)}` +
        `&frame_id=0x${s.frame_id.toString(16)}&signal=${encodeURIComponent(s.signal)}&channel=${s.channel}`);
      let cs = msgCache[s.frame_id];
      if (!cs) {
        cs = await api(`/api/blf/${state.blf}/cycle-stats?dbc=${encodeURIComponent(dbc)}` +
          `&frame_id=0x${s.frame_id.toString(16)}&channel=${s.channel}`);
        msgCache[s.frame_id] = cs;
      }
      // 抖动峰值时间点 → 示波器 x 轴标记(记录信号名,按示波器过滤)
      if (cs.jitter_max_at != null) {
        state.jitterMarks.push({ t: cs.jitter_max_at - state.t0, color: s.color, signal: s.signal });
      }
      rows.push({ s, st, cs });
    }
    // 信号统计表
    let html = `<table class="sig-stats"><thead><tr>
      <th>信号</th><th>通道</th><th>点数</th><th>min</th><th>max</th><th>mean</th><th>std</th><th>最后值</th><th>超范围</th>
      </tr></thead><tbody>`;
    for (const { s, st } of rows) {
      const oorTitle = st.range_min != null || st.range_max != null
        ? `定义范围 [${st.range_min ?? "—"}, ${st.range_max ?? "—"}]` : "";
      html += `<tr>
        <td><span class="dot" style="background:${s.color};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>${s.signal}</td>
        <td>CH${s.channel}</td>
        <td>${st.count}</td>
        <td>${fmtUnit(s, st.min)}</td><td>${fmtUnit(s, st.max)}</td>
        <td>${fmtUnit(s, st.mean)}</td><td>${fmtUnit(s, st.std)}</td>
        <td>${fmtUnit(s, st.last)}</td>
        <td title="${oorTitle}" class="${(st.out_of_range ?? 0) > 0 ? "warn" : ""}">${st.out_of_range != null ? `${st.out_of_range} 个` : "—"}</td>
      </tr>`;
      if (st.choices_dist) {
        const dist = Object.entries(st.choices_dist)
          .map(([k, v]) => `${k}: ${v}`).join(" · ");
        html += `<tr><td colspan="8" style="color:#8a93a3">状态分布: ${dist}</td></tr>`;
      }
    }
    html += `</tbody></table>`;
    // 报文周期段
    const seenMsg = new Set();
    html += `<table class="sig-stats"><tbody>`;
    for (const { s, cs } of rows) {
      if (seenMsg.has(s.frame_id)) continue;
      seenMsg.add(s.frame_id);
      const exp = cs.expected_ms ? `${cs.expected_ms} ms` : "—";
      html += `<tr class="sec"><td colspan="8">报文 ${cs.name} (0x${s.frame_id.toString(16)}) · CH${s.channel}</td></tr>
        <tr>
          <td>期望周期</td><td>${exp}</td><td>实测平均</td><td>${cs.avg_ms ?? "—"} ms</td>
          <td>min</td><td>${cs.min_ms ?? "—"} ms</td><td>max</td><td>${cs.max_ms ?? "—"} ms</td>
        </tr>
        <tr>
          <td>抖动(峰峰)</td><td class="${(cs.jitter_ms ?? 0) > (cs.expected_ms || 1) * 0.3 ? "warn" : ""}">${cs.jitter_ms ?? "—"} ms${cs.jitter_max_at != null ? ` <span style="color:#8a93a3">@ ${(cs.jitter_max_at - state.t0).toFixed(3)}s</span>` : ""}</td>
          <td>丢帧</td><td class="${(cs.lost_frames ?? 0) > 0 ? "warn" : ""}">${cs.lost_frames ?? "—"}</td>
          <td>丢帧率</td><td>${cs.lost_pct ?? "—"}%</td><td colspan="2"></td>
        </tr>`;
    }
    html += `</tbody></table>`;
    box.innerHTML = html;
    // 抖动峰值标记已更新 → 重绘示波器 overlay
    renderOverlays();
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败: ${e.message}</div>`;
  }
}

document.getElementById("cfg-bus-type").addEventListener("change", syncBusTypeUI);
// 切换 Bus Log → 即时刷新文件信息 + 通道 DBC 预览(未保存前映射视为空)
document.getElementById("cfg-blf").addEventListener("change", () => refreshBlfViews());

async function init() {
  try { state.config = await api("/api/config"); } catch (e) { state.config = {}; }
  fillConfig();        // ⚠️ 先填充配置抽屉(BusLog 下拉/通道 DBC):独立于 loadFiles,
                       // 否则 loadFiles 失败(缺 BLF/解析异常)会导致下拉永远空、无法选择
  try {
    await loadFiles();
  } catch (e) {
    showTip(e.message || "文件加载失败");
  }
  connectReplay();   // 预连接播放 WS(避免首次播放的连接延迟/失败)
}

/* ============ 播放模式(CANoe 式动态回放:后端逐帧解析推送) ============ */
const playState = {
  ws: null, playing: false, rate: 1.0, t: 0.0, dur: 0.0,
  data: {},            // key(frame_id|channel|signal) -> {times, values} 累积
  renderPending: false,
};

function showPlaybar(show) {
  const bar = document.getElementById("playbar");
  if (bar) bar.style.display = show ? "" : "none";
}

let replayQueue = [];   // WS 未就绪时的待发消息(连接建立后 flush)
/* 播放诊断(排障):WS 状态 / 消息计数 / 数据点数 实时显示 */
const diag = { msgs: 0, batch: 0, progress: 0, state: 0, lastBatchT: 0, wsOpen: 0, errs: 0 };
function updateDiag() {
  const el = document.getElementById("play-diag");
  if (!el) return;
  const pts = Object.values(playState.data).reduce((a, d) => a + (d.times ? d.times.length : 0), 0);
  el.textContent = `WS:${playState.ws ? playState.ws.readyState : "-"} 收:${diag.msgs}(st:${diag.state}/bt:${diag.batch}/pg:${diag.progress}) 点:${pts} t:${playState.t.toFixed(2)}s play:${playState.playing ? "Y" : "N"} draw:${diagTime.lastDraw.toFixed(1)}ms upd:${(diagTime.lastUpdate || 0).toFixed(1)}ms`;
}

function connectReplay() {
  if (playState.ws && playState.ws.readyState === 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  playState.ws = new WebSocket(`${proto}://${location.host}/ws/replay`);
  playState.ws.onopen = () => {
    // 连接建立后补发排队消息(config/play),避免"删了再加后播放没反应"
    replayQueue.forEach(m => playState.ws.send(JSON.stringify(m)));
    replayQueue = [];
  };
  playState.ws.onmessage = e => {
    diag.msgs++;
    try { onReplayMsg(JSON.parse(e.data)); }
    catch (err) { diag.errs++; showTip("播放消息处理错误: " + err.message); }
    updateDiag();
  };
  playState.ws.onerror = () => { diag.errs++; updateDiag(); };
  playState.ws.onclose = () => {
    playState.playing = false;
    playState.ws = null;   // 置空,下次 startPlayback 重新连接
    updatePlayUI();
  };
}

function sendReplay(msg) {
  if (playState.ws && playState.ws.readyState === 1) playState.ws.send(JSON.stringify(msg));
  else replayQueue.push(msg);   // 未就绪 → 排队,连接后补发
}

/* 重置播放累积(清空曲线数据) */
/* 播放结束后恢复静态全量数据(播放数据只是临时覆盖,防止残留稀疏数据) */
function restoreStaticData() {
  // 批次3+:停止/结束后保留播放数据(曲线停在播放位置);
  // 不主动清 winData —— "全部显示"的静态全量在停止后保持,重新播放时覆盖为动态
  state.signals.forEach(s => { /* winData 保留 */ });
}

function resetPlayData() {
  playState.data = {};
  state.signals.forEach(s => { s.data = { times: [], values: [] }; });
}

/* 开始/继续播放:清空累积 → 配置订阅 → 播放 */
function startPlayback() {
  if (!state.signals.length) { showTip("请先添加信号"); return; }
  if (!state.blf) { showTip("请先选择 BLF 文件"); return; }
  cancelAnimationFrame(playRaf);
  playState.renderPending = false;
  state.xRange = null;   // 播放开始时 x 范围由首批数据/state 决定,之后固定
  if (!playState.ws || playState.ws.readyState !== 1) connectReplay();
  state.signals.forEach(s => { s.winData = null; });   // 播放开始清窗口懒加载
  resetPlayData();
  draw();   // 清空曲线
  const subs = state.signals.map(s => ({
    frame_id: s.frame_id, channel: s.channel, signal: s.signal, dbc: s.dbc || "",
  }));
  sendReplay({ type: "config", blf: state.blf, signals: subs });
  sendReplay({ type: "play", rate: playState.rate });
}

function togglePlay() {
  if (playState.playing) sendReplay({ type: "pause" });
  else startPlayback();
}

function stopPlayback() {
  sendReplay({ type: "stop" });
  playState.playing = false;
  playState.t = 0;
  state.xRange = null;
  cancelAnimationFrame(playRaf);
  playState.renderPending = false;
  playState.data = {};      // 停止 → 清空播放累积(下次播放全新开始)
  restoreStaticData();      // 停止 → 恢复静态全量曲线
  draw();
  updatePlayUI();
}

/* 进度条拖动定位 */
function seekPlayback(pct) {
  const t = playState.dur > 0 ? (pct / 1000) * playState.dur : 0;
  playState.t = t;
  resetPlayData();
  draw();
  sendReplay({ type: "seek", t });
  updatePlayUI();
}

function setPlayRate(r) {
  playState.rate = parseFloat(r);
  if (playState.playing) sendReplay({ type: "play", rate: playState.rate });   // 播放中变速
}

/* 收到后端推送(帧批次 → 累积 → 节流渲染) */
let _firstBatchT = 0;
function onReplayMsg(m) {
  if (m.type === "batch") { diag.batch++; diag.lastBatchT = Date.now();
    if (!_firstBatchT) {
      _firstBatchT = Date.now();
      // 自检:2 秒后仍无任何数据 → 提示(区分构建中/WS 异常)
      setTimeout(() => {
        const has = Object.values(playState.data).some(d => d.times.length > 0);
        if (!has && playState.playing) {
          const busy = document.getElementById("busy-toast");
          if (busy && busy.style.display !== "none") {
            showTip("⏳ 索引构建中,播放数据随构建推进(大文件早期可能需要等待构建完成)");
          } else {
            showTip("⚠ 未收到播放数据(WS 或后端订阅异常),请刷新页面重试");
          }
        }
      }, 2000);
    }
    for (const [key, d] of Object.entries(m.signals)) {
      if (!playState.data[key]) playState.data[key] = { times: [], values: [] };
      playState.data[key].times.push(...d.times);
      playState.data[key].values.push(...d.values);
    }
    playState.t = m.t1;
    schedulePlayRender();
  } else if (m.type === "progress") {
    diag.progress++;
    playState.t = m.t;
    updateProgressUI();
  } else if (m.type === "state") {
    diag.state++;
    playState.playing = m.playing;
    playState.rate = m.rate;
    playState.dur = m.dur;
    updatePlayUI();
  } else if (m.type === "end") {
    playState.playing = false;
    state.xRange = null;      // 结束 → 恢复自动 x 范围
    cancelAnimationFrame(playRaf);
    playState.renderPending = false;
      restoreStaticData();      // 播放数据覆盖 → 恢复静态全量
    draw();   // 最终渲染全量
    updatePlayUI();
    showTip("回放结束");
  }
}

/* 渲染循环:rAF 毫秒级把累积数据应用到示波器(曲线随时间平滑增长) */
let playRaf = 0;
function schedulePlayRender() {
  if (playState.renderPending) return;
  playState.renderPending = true;
  playRaf = requestAnimationFrame(playRenderLoop);
}
function playRenderLoop() {
  playState.renderPending = false;
  applyPlayData();
  // 播放中持续以显示刷新率重绘(数据未变时 draw 内部 setData 开销极小)
  if (playState.playing) {
    playState.renderPending = true;
    playRaf = requestAnimationFrame(playRenderLoop);
  }
}

/* StreamRenderer:累积数据 → state.signals → draw(增量曲线) */
function applyPlayData() {
  let any = false;
  for (const s of state.signals) {
    const key = `${s.frame_id}|${s.channel}|${s.signal}`;
    const d = playState.data[key];
    if (d && d.times.length) {
      s.data = { times: d.times, values: d.values };
      any = true;
    }
  }
  if (!any) return;
  // 播放模式:x 轴固定全量范围(时间轴不动,曲线在固定时间轴上往后画)
  if (playState.dur > 0) state.xRange = { min: 0, max: playState.dur };
  draw();
}

function updatePlayUI() {
  const btn = document.getElementById("btn-play");
  if (btn) {
    btn.textContent = playState.playing ? "⏸" : "▶";
    btn.classList.toggle("playing", playState.playing);
  }
  updateProgressUI();
}

function updateProgressUI() {
  const prog = document.getElementById("play-progress");
  const tEl = document.getElementById("play-time");
  const dEl = document.getElementById("play-dur");
  if (prog && playState.dur > 0) prog.value = Math.min(1000, playState.t / playState.dur * 1000);
  if (tEl) tEl.textContent = playState.t.toFixed(1) + "s";
  if (dEl && playState.dur > 0) dEl.textContent = playState.dur.toFixed(1) + "s";
}

/* 播放中信号集变化 → 自动暂停(避免数据不同步),并恢复静态全量 */
function pausePlayOnSignalChange() {
  if (playState.playing) {
    sendReplay({ type: "pause" });
    playState.playing = false;
    cancelAnimationFrame(playRaf);
    playState.renderPending = false;
    restoreStaticData();
    updatePlayUI();
  }
}

setInterval(updateDiag, 800);   // 诊断条定时刷新

/* 后台构建进度:轮询 /api/admin/progress → 顶部细提示条(不遮挡页面,可继续操作) */
async function pollBusyProgress() {
  try {
    const r = await fetch("/api/admin/progress");
    const d = await r.json();
    const entries = Object.values(d.progress || {});
    const bar = document.getElementById("busy-toast");
    if (!bar) return;
    if (entries.length) {
      const e = entries[0];
      const pct = Math.round((e.progress || 0) * 100);
      document.getElementById("busy-toast-bar").style.width = pct + "%";
      document.getElementById("busy-toast-text").textContent =
        `⏳ ${e.stage || "后台构建"} · ${pct}%`;
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  } catch (err) { /* 后端重启/断连时忽略 */ }
}
setInterval(pollBusyProgress, 500);

init().catch(e => {
  document.getElementById("tree-hint").textContent = "加载失败: " + e.message;
});







