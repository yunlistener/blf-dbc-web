/* CANoe 风格前端逻辑:文件 → 报文树 → 多信号曲线 → Trace → 统计 */
"use strict";

const PALETTE = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff", "#4dd6c8"];
const MAX_SERIES = 6;   // uPlot 系列数固定,槽位复用

const state = {
  blf: null,
  dbc: null,
  stats: null,
  signals: [],       // 已选信号 [{frame_id, signal, unit, color, slot, data}]
  uplot: null,
  trace: { frameId: null, offset: 0, limit: 200 },
};

function showTip(msg) { document.getElementById("st-tip").textContent = msg; }
window.addEventListener("error", (e) => {
  const stack = (e.error && e.error.stack || "").split("\n")[1] || "";
  showTip("JS错误: " + e.message + " " + stack.trim());
});
window.addEventListener("unhandledrejection", (e) => showTip("异常: " + e.reason));

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  return r.json();
}

/* ---------- uPlot ---------- */
function onCursorMove(u, x, y) {
  const t = u.posToVal(x, "x");
  document.getElementById("ro-time").textContent = t.toFixed(3) + " s";
  const idx = u.posToIdx(x);
  const box = document.getElementById("ro-signals");
  box.innerHTML = "";
  state.signals.forEach(s => {
    const v = u.data[s.slot] ? u.data[s.slot][idx] : null;
    const div = document.createElement("span");
    div.className = "ro-sig-val";
    div.innerHTML = `<span class="dot" style="background:${s.color}"></span>
      ${s.signal}: <b>${v == null ? "—" : Number(v.toPrecision(6))}</b>
      <span class="u">${s.unit || ""}</span>`;
    box.appendChild(div);
  });
}

function draw() {
  const u = state.uplot;
  if (!state.signals.length) {
    if (u) {
      for (let i = 1; i <= MAX_SERIES; i++) u.setSeries(i, { show: false });
      u.setData([[], ...Array(MAX_SERIES).fill([])]);
    }
    document.getElementById("ro-signals").innerHTML = "";
    return;
  }
  // 时间轴对齐
  const xSet = new Set();
  for (const s of state.signals) for (const t of s.data.times) xSet.add(t);
  const x = Array.from(xSet).sort((a, b) => a - b);
  const per = {};
  for (const s of state.signals) {
    const v = new Array(x.length).fill(null);
    const t = s.data.times;
    let j = 0;
    for (let i = 0; i < x.length; i++) {
      while (j < t.length && t[j] < x[i]) j++;
      if (j < t.length && t[j] === x[i]) v[i] = s.data.values[j];
    }
    per[s.slot] = v;
  }
  if (!u) {
    state.uplot = new uPlot(makeUplotOpts(), [x, ...Array(MAX_SERIES).fill([])],
      document.getElementById("chart"));
  }
  // 每次绘制都同步系列显示配置(新加入的信号可能晚于创建)
  state.signals.forEach(s => applySeries(s));
  const data = [x];
  for (let i = 1; i <= MAX_SERIES; i++) data.push(per[i] || []);
  state.uplot.setData(data);
  if (x.length > 1) state.uplot.setScale("x", { min: x[0], max: x[x.length - 1] });
  let lo = Infinity, hi = -Infinity;
  for (const s of state.signals) {
    lo = Math.min(lo, ...s.data.values);
    hi = Math.max(hi, ...s.data.values);
  }
  if (isFinite(lo)) state.uplot.setScale("y", lo === hi ? { min: lo - 1, max: hi + 1 } : { min: lo, max: hi });
  // 手动刷新读数面板(无鼠标事件时也显示光标处各信号值)
  const b = state.uplot.bbox;
  state.uplot.setCursor({ left: b.width / 2, top: b.height / 2 });
}

/* 更新/隐藏某个系列槽位的显示配置 */
function applySeries(s) {
  const u = state.uplot;
  if (!u) return;
  u.setSeries(s.slot, { show: true, label: s.signal, stroke: s.color, width: 1.5, points: { show: false } });
}

function makeUplotOpts() {
  const el = document.getElementById("chart");
  return {
    width: el.clientWidth - 16,
    height: el.clientHeight - 16,
    legend: { show: false },
    scales: { x: { time: false }, y: { auto: false } },
    axes: [
      { stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
        ticks: { stroke: "#3a4150" }, font: "11px ui-monospace, Menlo",
        values: (u, vals) => vals.map(v => v.toFixed(2) + "s") },
      { stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
        ticks: { stroke: "#3a4150" }, font: "11px ui-monospace, Menlo", size: 58 },
    ],
    series: [{}, ...Array(MAX_SERIES).fill({ show: false })],
    cursor: {
      x: true, y: true,
      stroke: "#7dd3fc", width: 1, dash: [4, 3],
      move: (u, x, y) => {
        onCursorMove(u, x, y);
        return [x, y];
      },
    },
    select: { show: true, fill: "rgba(77,163,255,.12)", stroke: "#4da3ff" },
    hooks: {
      setSelect: [(u) => {
        const { min, max } = u.select;
        u.setScale("x", { min, max });
      }],
      ready: [(u) => {
        u.over.addEventListener("wheel", (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 0.85 : 1.18;
          const cx = u.posToVal(e.offsetX, "x");
          u.batch(() => {
            const { min, max } = u.scales.x;
            u.setScale("x", {
              min: cx - (cx - min) * factor,
              max: cx + (max - cx) * factor,
            });
          });
        }, { passive: false });
      }],
    },
  };
}

/* ---------- 数据加载 ---------- */
async function loadFiles() {
  const { files } = await api("/api/files");
  state.blf = files.find(f => f.kind === ".blf")?.name;
  state.dbc = files.find(f => f.kind === ".dbc")?.name;
  if (!state.blf || !state.dbc) throw new Error("缺少 BLF 或 DBC 文件,请先上传");
  document.getElementById("file-blf").textContent = "BLF: " + state.blf;
  document.getElementById("file-dbc").textContent = "DBC: " + state.dbc;

  state.stats = await api(`/api/blf/${state.blf}/stats`);
  document.getElementById("st-frames").textContent = `帧数 ${state.stats.total_frames}`;
  document.getElementById("st-duration").textContent = `时长 ${state.stats.duration_s.toFixed(1)} s`;
  document.getElementById("st-ids").textContent = `报文数 ${state.stats.unique_ids}`;
  await loadDbcTree();
  renderStats();
}

async function loadDbcTree() {
  const { messages } = await api(`/api/dbc/${state.dbc}/messages`);
  const tree = document.getElementById("msg-tree");
  tree.innerHTML = "";

  // Trace 报文选择下拉
  const sel = document.getElementById("trace-msg");
  sel.innerHTML = messages.map(m =>
    `<option value="${m.frame_id}">${m.frame_id_hex} ${m.name}</option>`).join("");

  for (const m of messages) {
    const wrap = document.createElement("div");
    wrap.className = "msg-item";

    const head = document.createElement("div");
    head.className = "msg-head";
    head.innerHTML = `<span class="msg-id">${m.frame_id_hex}</span>
      <span class="msg-name">${m.name}</span>
      <span class="msg-count">${m.signal_count} 信号</span>`;
    head.onclick = () => {
      const list = wrap.querySelector(".sig-list");
      list.style.display = list.style.display === "none" ? "" : "none";
    };
    wrap.appendChild(head);

    const list = document.createElement("div");
    list.className = "sig-list";
    list.style.display = "none";
    for (const s of m.signals) {
      const item = document.createElement("div");
      item.className = "sig-item";
      item.innerHTML = `<span class="sig-dot"></span>
        <span class="sig-name">${s}</span>
        <span class="sig-unit">${m.frame_id_hex}</span>`;
      item.onclick = () => toggleSignal(m, s, item);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    tree.appendChild(wrap);
  }
  document.getElementById("tree-hint")?.remove();

  // 自动选中第一个报文的前两个信号(demo 便利,展示多信号叠加)
  if (messages.length > 0 && messages[0].signals.length >= 2) {
    const first = document.querySelector(".msg-head");
    first?.click();
    const items = document.querySelectorAll(".sig-item");
    toggleSignal(messages[0], messages[0].signals[0], items[0]);
    toggleSignal(messages[0], messages[0].signals[1], items[1]);
  } else if (messages.length > 0 && messages[0].signals.length > 0) {
    toggleSignal(messages[0], messages[0].signals[0], document.querySelector(".sig-item"));
  }

  // 初始化 Trace 面板(默认选中第一个报文)
  onTraceMsgChange();
}

async function toggleSignal(msg, signal, item) {
  const existing = state.signals.find(s => s.signal === signal && s.frame_id === msg.frame_id);
  if (existing) {
    state.signals = state.signals.filter(s => s !== existing);
    item.classList.remove("active");
    if (state.uplot) state.uplot.setSeries(existing.slot, { show: false });
    draw();
    return;
  }
  if (state.signals.length >= MAX_SERIES) {
    showTip(`最多同时显示 ${MAX_SERIES} 个信号`);
    return;
  }
  item.classList.add("active");
  const used = new Set(state.signals.map(s => s.color));
  const color = PALETTE.find(c => !used.has(c)) || PALETTE[state.signals.length % PALETTE.length];

  const detail = await api(`/api/dbc/${state.dbc}/messages/${msg.frame_id_hex}`);
  const sigDef = detail.signals.find(s => s.name === signal);
  const unit = sigDef?.unit || "";

  const data = await api(`/api/blf/${state.blf}/decode?dbc=${state.dbc}` +
    `&frame_id=${msg.frame_id_hex}&signal=${encodeURIComponent(signal)}&max_points=200000`);
  // 槽位分配须与 push 同步完成(避免并发请求拿到相同槽位)
  const usedSlots = new Set(state.signals.map(s => s.slot));
  const slot = [1, 2, 3, 4, 5, 6].find(i => !usedSlots.has(i));
  state.signals.push({ frame_id: msg.frame_id, signal, unit, color, slot, data });
  draw();
}

/* ---------- 导出 ---------- */
document.getElementById("btn-export").onclick = () => {
  if (!state.signals.length) {
    showTip("请先选择至少一个信号");
    return;
  }
  const s = state.signals[0];
  window.location.href = `/api/blf/${state.blf}/export?dbc=${state.dbc}` +
    `&frame_id=0x${s.frame_id.toString(16)}`;
};

document.getElementById("btn-reset").onclick = () => {
  if (state.signals.length && state.uplot) {
    const x = state.uplot.data[0];
    state.uplot.setScale("x", { min: x[0], max: x[x.length - 1] });
  }
};
window.addEventListener("resize", () => {
  if (state.uplot) {
    state.uplot.setSize({
      width: document.getElementById("chart").clientWidth - 16,
      height: document.getElementById("chart").clientHeight - 16,
    });
  }
});

/* ---------- Trace 表格 ---------- */
function onTraceMsgChange() {
  state.trace.frameId = parseInt(document.getElementById("trace-msg").value, 10);
  state.trace.offset = 0;
  loadTrace();
}

async function loadTrace() {
  const fid = state.trace.frameId;
  if (!fid) return;
  const body = document.getElementById("trace-body");
  body.innerHTML = `<tr><td colspan="6" class="hint">加载中…</td></tr>`;
  const r = await api(`/api/blf/${state.blf}/frames?dbc=${state.dbc}` +
    `&frame_id=${fid}&limit=${state.trace.limit}&offset=${state.trace.offset}`);
  document.getElementById("trace-info").textContent =
    `第 ${state.trace.offset + 1}-${state.trace.offset + r.returned} 帧`;
  document.getElementById("trace-prev").disabled = state.trace.offset === 0;
  document.getElementById("trace-next").disabled = r.returned < state.trace.limit;

  body.innerHTML = "";
  for (const f of r.frames) {
    const tr = document.createElement("tr");
    let dec = "";
    if (f.decoded) {
      dec = Object.entries(f.decoded)
        .map(([k, v]) => `<span class="dv">${k}=${Number(v.toPrecision(6))}</span>`)
        .join("");
    }
    tr.innerHTML = `<td class="t-time">${f.timestamp.toFixed(3)}</td>
      <td class="t-id">${f.id_hex}</td><td>${f.name}</td><td>${f.dlc}</td>
      <td class="t-data">${f.data}</td><td class="t-decoded">${dec}</td>`;
    body.appendChild(tr);
  }
  if (!r.returned) body.innerHTML = `<tr><td colspan="6" class="hint">无数据</td></tr>`;
}

function tracePage(dir) {
  state.trace.offset = Math.max(0, state.trace.offset + dir * state.trace.limit);
  loadTrace();
}

/* ---------- ID 统计 ---------- */
function renderStats() {
  const box = document.getElementById("stats-box");
  const ids = state.stats.by_id;
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
  if (name === "trace" && !state.trace.frameId) onTraceMsgChange();
  if (name === "stats") renderStats();
}

loadFiles().catch(e => {
  document.getElementById("tree-hint").textContent = "加载失败: " + e.message;
});
