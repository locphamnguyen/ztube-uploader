// Bảng nổi trên trang YouTube Studio: nhật ký, hàng đợi và nút Bắt đầu/Dừng của extension — khỏi phải chuyển sang trang điều khiển.
// Dữ liệu lấy từ trang điều khiển (uploader.html, nơi giữ quyền đọc thư mục video): khi tải trang thì hỏi "overlay-sync",
// sau đó trang điều khiển tự đẩy "overlay" mỗi khi có log hoặc đổi trạng thái.
// Dựng DOM trong shadow root đóng: các bước tự động (document.querySelectorAll) và AI không nhìn thấy/bấm nhầm vào bảng này.
// Studio bật Trusted Types nên không dùng innerHTML.
(() => {
  if (window.__ytuOverlay) return;
  window.__ytuOverlay = true;

  const STATUS = {
    pending: ["Chờ", "#8a93a6"],
    running: ["Đang đăng", "#f0a020"],
    done: ["Đã đăng", "#2fbf71"],
    scheduled: ["Đã hẹn", "#2fbf71"],
    error: ["Lỗi", "#ff5a5a"],
    skip: ["Bỏ qua", "#8a93a6"],
  };
  const PREF_KEY = "ytuOverlay";
  let prefs = { x: null, y: null, collapsed: false, hidden: false };
  let data = null;
  let follow = true; // tự cuộn log xuống cuối, trừ khi người dùng đang cuộn lên xem

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const host = el("div");
  host.id = "ytu-overlay-host";
  Object.assign(host.style, { position: "fixed", zIndex: "2147483000", left: "16px", bottom: "16px", top: "auto" });
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { width: 440px; max-width: calc(100vw - 32px); background: rgba(18,20,24,.94); color: #e6e8ec; border: 1px solid #2c313a;
      border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); font: 12.5px/1.45 system-ui, "Segoe UI", sans-serif; overflow: hidden;
      backdrop-filter: blur(6px); }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1b1e24; cursor: move; user-select: none; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #8a93a6; flex: none; }
    .dot.run { background: #f0a020; box-shadow: 0 0 0 0 rgba(240,160,32,.7); animation: pulse 1.4s infinite; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 7px rgba(240,160,32,0); } 100% { box-shadow: 0 0 0 0 rgba(240,160,32,0); } }
    .title { font-weight: 600; font-size: 13px; }
    .sub { color: #9aa1ae; font-size: 11.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { all: unset; cursor: pointer; padding: 3px 9px; border-radius: 6px; border: 1px solid #3a404b; color: #e6e8ec; font-size: 12px; }
    button:hover { background: #2a2f38; }
    button.go { background: #e8272b; border-color: #e8272b; color: #fff; }
    button.go:hover { background: #c91f23; }
    button:disabled, button[disabled] { opacity: .4; cursor: default; background: transparent; }
    button.icon { padding: 2px 7px; border-color: transparent; color: #9aa1ae; }
    .body { padding: 8px 10px 10px; }
    .jobs { max-height: 150px; overflow: auto; margin-bottom: 8px; border: 1px solid #2c313a; border-radius: 8px; }
    .job { display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; padding: 4px 8px; border-bottom: 1px solid #23272f; align-items: start; }
    .job:last-child { border-bottom: 0; }
    .job .n { color: #9aa1ae; }
    .job .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .job .st { font-weight: 600; white-space: nowrap; }
    .job .x { grid-column: 2 / 4; color: #9aa1ae; font-size: 11.5px; overflow-wrap: anywhere; }
    .job .x.err { color: #ff8a8a; }
    .job a { color: #6cb6ff; text-decoration: none; }
    .log { height: 210px; overflow: auto; margin: 0; padding: 8px; background: #0d0f12; border: 1px solid #2c313a; border-radius: 8px;
      font: 11.5px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: #c9ced8; }
    .log .e { color: #ff8a8a; } .log .ok { color: #7ee2a8; } .log .s { color: #ffd27a; }
    .bar { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    .bar .sp { flex: 1; }
    .off { padding: 10px; color: #c9ced8; }
    .collapsed .body { display: none; }
  `);
  root.adoptedStyleSheets = [sheet];

  const box = el("div", "box");
  const head = el("div", "head");
  const dot = el("span", "dot");
  const title = el("span", "title", "YT Uploader");
  const sub = el("span", "sub", "");
  const btnCollapse = el("button", "icon", "–");
  btnCollapse.title = "Thu gọn / mở rộng";
  const btnHide = el("button", "icon", "×");
  btnHide.title = "Ẩn bảng (bấm nút ▶ nhỏ ở góc để hiện lại)";
  head.append(dot, title, sub, btnCollapse, btnHide);

  const body = el("div", "body");
  const jobs = el("div", "jobs");
  const log = el("pre", "log");
  const bar = el("div", "bar");
  const btnStart = el("button", "go", "▶ Bắt đầu đăng");
  const btnStop = el("button", "", "■ Dừng sau video này");
  const btnPanel = el("button", "", "⚙ Trang điều khiển");
  bar.append(btnStart, btnStop, el("span", "sp"), btnPanel);
  const off = el("div", "off", "");
  body.append(jobs, log, bar, off);
  box.append(head, body);

  const mini = el("button", "go", "▶ YT Uploader");
  mini.style.display = "none";
  root.append(box, mini);

  // ---------- vị trí / thu gọn ----------
  function applyPrefs() {
    box.classList.toggle("collapsed", !!prefs.collapsed);
    btnCollapse.textContent = prefs.collapsed ? "+" : "–";
    box.style.display = prefs.hidden ? "none" : "";
    mini.style.display = prefs.hidden ? "" : "none";
    if (prefs.x != null && prefs.y != null) {
      const w = host.offsetWidth || 440;
      const h = host.offsetHeight || 40;
      Object.assign(host.style, {
        left: Math.max(0, Math.min(prefs.x, innerWidth - Math.min(w, 120))) + "px",
        top: Math.max(0, Math.min(prefs.y, innerHeight - Math.min(h, 40))) + "px",
        bottom: "auto",
      });
    }
  }
  const savePrefs = () => chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});

  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("button")) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      prefs.x = ev.clientX - dx;
      prefs.y = ev.clientY - dy;
      applyPrefs();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      savePrefs();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });
  btnCollapse.onclick = () => {
    prefs.collapsed = !prefs.collapsed;
    applyPrefs();
    savePrefs();
  };
  btnHide.onclick = () => {
    prefs.hidden = true;
    applyPrefs();
    savePrefs();
  };
  mini.onclick = () => {
    prefs.hidden = false;
    applyPrefs();
    savePrefs();
  };
  log.addEventListener("scroll", () => {
    follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  });

  // ---------- lệnh gửi trang điều khiển ----------
  const cmd = (action) => chrome.runtime.sendMessage({ type: "overlay-cmd", action }).catch(() => null);
  btnStart.onclick = () => cmd("start");
  btnStop.onclick = () => cmd("stop");
  btnPanel.onclick = () => chrome.runtime.sendMessage({ type: "open-uploader" }).catch(() => {});

  // ---------- vẽ ----------
  function draw() {
    const connected = !!data;
    jobs.style.display = log.style.display = bar.style.display = connected ? "" : "none";
    off.style.display = connected ? "none" : "";
    if (!connected) {
      dot.className = "dot";
      sub.textContent = "chưa mở trang điều khiển";
      off.replaceChildren(
        document.createTextNode("Mở trang điều khiển để chọn thư mục video. Sau đó nhật ký và nút Bắt đầu/Dừng hiện ngay tại đây. "),
        Object.assign(el("button", "go", "Mở trang điều khiển"), { onclick: () => chrome.runtime.sendMessage({ type: "open-uploader" }).catch(() => {}) })
      );
      return;
    }
    const list = data.jobs || [];
    const nDone = list.filter((j) => j.status === "done" || j.status === "scheduled").length;
    const cur = list.find((j) => j.status === "running");
    dot.className = data.running ? "dot run" : "dot";
    sub.textContent = data.running
      ? `${nDone}/${list.length} · ${cur ? `#${cur.n} ${cur.step || ""}` : "đang chạy"}`
      : `${data.source || "chưa chọn thư mục"} · ${nDone}/${list.length} xong`;

    jobs.replaceChildren(
      ...(list.length
        ? list.map((j) => {
            const row = el("div", "job");
            const [label, color] = STATUS[j.status] || STATUS.pending;
            const st = el("span", "st", j.status === "running" && j.step ? `${label} · ${j.step}` : label);
            st.style.color = color;
            const t = el("span", "t", j.title || j.file || "");
            t.title = j.title || "";
            row.append(el("span", "n", String(j.n)), t, st);
            if (j.url) {
              const x = el("div", "x");
              const a = el("a", "", j.url.replace(/^https?:\/\//, ""));
              a.href = j.url;
              a.target = "_blank";
              x.append(a);
              row.append(x);
            }
            if (j.error) row.append(el("div", "x err", j.error));
            return row;
          })
        : [el("div", "job", "Chưa có video trong hàng đợi")])
    );
    if (cur) jobs.children[list.indexOf(cur)]?.scrollIntoView({ block: "nearest" });

    log.replaceChildren(
      ...(data.logs || []).map((line) => {
        const cls = /✗|Lỗi|lỗi:|dừng:/.test(line) ? "e" : /✓/.test(line) ? "ok" : / → /.test(line) ? "s" : "";
        return el("div", cls, line);
      })
    );
    if (follow) log.scrollTop = log.scrollHeight;

    btnStart.disabled = !data.canStart;
    btnStop.disabled = !data.running;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.cmd === "overlay") {
      data = msg.data;
      draw();
    }
  });

  async function sync() {
    data = (await chrome.runtime.sendMessage({ type: "overlay-sync" }).catch(() => null)) || null;
    draw();
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 300);
    document.body.appendChild(host);
    chrome.storage.local.get(PREF_KEY).then((r) => {
      prefs = { ...prefs, ...(r?.[PREF_KEY] || {}) };
      applyPrefs();
    }).catch(() => applyPrefs());
    addEventListener("resize", applyPrefs);
    sync();
    // Trang điều khiển có thể được mở/đóng bất cứ lúc nào: hỏi lại định kỳ để biết còn kết nối không.
    setInterval(sync, 5000);
  }
  mount();
})();
