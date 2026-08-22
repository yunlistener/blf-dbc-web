/* CANoe 风格前端逻辑:文件 → 报文树 → uPlot 曲线(十字光标 + 缩放) */
"use strict";

// 调试:把 JS 错误显示在状态栏
function showTip(msg) { document.getElementById("st-tip").textContent = msg; }
window.addEventListener("error", (e) => {
  const stack = (e.error && e.error.stack || "").split("\n")[1] || "";
  showTip("JS错误: " + e.message + " " + stack.trim());
});
window.addEventListener("unhandledrejection", (e) => showTip("异常: " + e.reason));

const PALETTE = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff", "#4dd6c8"];

const state = {
  blf: null,        // BLF 文件名
  dbc: null,        // DBC 文件名
  stats: null,
  signalIdx: {},    // signal name -> {frame_id, unit}
  active: null,     // 当前信号 {frame_id, signal, unit, color, data}
  uplot: null,
};

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  return r.json();
}

function draw() {
  const a = state.active;
  if (!a) return;
  if (!state.uplot) {
    const el = document.getElementById("chart");
    try {
      state.uplot = new uPlot({
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
      series: [{}, {
        label: a.signal,
        stroke: a.color,
        width: 1.5,
        points: { show: false },
      }],
      cursor: {
        x: true, y: true,
        stroke: "#7dd3fc", width: 1, dash: [4, 3],
        move: (u, x, y) => {
          onCursorMove(u, x, y);
          return [x, y];  // uPlot 要求返回 [x,y] 覆盖光标位置
        },
      },
      select: { show: true, fill: "rgba(77,163,255,.12)", stroke: "#4da3ff" },
      hooks: {
        setSelect: [(u) => {
          const { min, max } = u.select;
          u.setScale("x", { min, max });
        }],
        ready: [(u) => {
          // 滚轮缩放(以鼠标位置为中心)
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
    }, [a.data.times, a.data.values], el);
    } catch (err) {
      showTip("uPlot创建失败: " + (err.stack || err));
      return;
    }
  } else {
    state.uplot.setData([a.data.times, a.data.values]);
  }
  // 重置到全范围
  const ts = a.data.times;
  state.uplot.setScale("x", { min: ts[0], max: ts[ts.length - 1] });
  const minV = Math.min(...a.data.values);
  const maxV = Math.max(...a.data.values);
  state.uplot.setScale("y", minV === maxV ? { min: minV - 1, max: maxV + 1 } : { min: minV, max: maxV });
}

/* 十字光标读数 → 底部读数面板 */
function onCursorMove(u, x, y) {
  const t = u.posToVal(x, "x");
  const idx = u.posToIdx(x);
  document.getElementById("ro-time").textContent = t.toFixed(3) + " s";
  if (state.active) {
    const v = u.data[1][idx];
    document.getElementById("ro-sig").textContent = state.active.signal;
    document.getElementById("ro-val").textContent = v == null ? "—" : Number(v.toPrecision(6));
    document.getElementById("ro-unit").textContent = state.active.unit || "";
  }
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
}

async function loadDbcTree() {
  const { messages } = await api(`/api/dbc/${state.dbc}/messages`);
  const tree = document.getElementById("msg-tree");
  tree.innerHTML = "";
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
      item.onclick = () => selectSignal(m, s, item);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    tree.appendChild(wrap);
  }
  document.getElementById("tree-hint")?.remove();

  // 自动展开第一个报文并选中一个信号,打开页面即可看到曲线
  if (messages.length > 0 && messages[0].signals.length > 1) {
    const first = document.querySelector(".msg-head");
    first?.click();
    const sigItems = document.querySelectorAll(".sig-item");
    selectSignal(messages[0], messages[0].signals[1], sigItems[1]);
  }
}

async function selectSignal(msg, signal, item) {
  // 点同一个信号 = 取消选择
  if (state.active && state.active.signal === signal && state.active.frame_id === msg.frame_id) {
    clearActive();
    document.querySelectorAll(".sig-item.active").forEach(n => n.classList.remove("active"));
    return;
  }
  document.querySelectorAll(".sig-item.active").forEach(n => n.classList.remove("active"));
  item.classList.add("active");

  const color = PALETTE[Object.keys(state.signalIdx).length % PALETTE.length];
  state.signalIdx[signal] = { frame_id: msg.frame_id, unit: "—" };

  // 取信号单位
  const detail = await api(`/api/dbc/${state.dbc}/messages/${msg.frame_id_hex}`);
  const sigDef = detail.signals.find(s => s.name === signal);
  const unit = sigDef?.unit || "";

  const data = await api(`/api/blf/${state.blf}/decode?dbc=${state.dbc}` +
    `&frame_id=${msg.frame_id_hex}&signal=${encodeURIComponent(signal)}&max_points=200000`);
  showTip("加载完成,绘制中…");
  state.active = { frame_id: msg.frame_id, signal, unit, color, data };
  document.getElementById("ro-sig").textContent = signal;
  document.getElementById("ro-unit").textContent = unit;
  draw();
  showTip("点击左侧信号查看曲线 · 拖拽框选缩放 · 滚轮缩放");
}

function clearActive() {
  state.active = null;
  document.getElementById("ro-sig").textContent = "—";
  document.getElementById("ro-val").textContent = "—";
  document.getElementById("ro-time").textContent = "—";
  document.getElementById("ro-unit").textContent = "—";
  if (state.uplot) state.uplot.setData([[], []]);
}

document.getElementById("btn-reset").onclick = () => {
  if (state.active && state.uplot) {
    const ts = state.active.data.times;
    state.uplot.setScale("x", { min: ts[0], max: ts[ts.length - 1] });
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

loadFiles().catch(e => {
  document.getElementById("tree-hint").textContent = "加载失败: " + e.message;
});
