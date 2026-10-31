import { askAI, configuredProviders, PROVIDERS } from "./ai.js";
import { readSheet, writeResults } from "./sheet.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  root: null,        // FileSystemDirectoryHandle
  source: null,      // { kind: "xlsx" | "json", name }
  queue: null,       // nội dung queue.json (khi nguồn là JSON)
  jobs: [],          // video đã gộp defaults
  running: false,
  stopRequested: false,
  settings: {},
  files: new Map(),  // `${jobId}:${kind}` -> File
  waiters: new Map(),// jobId -> (event) => void
  logLines: [],      // nhật ký gần đây, gửi sang bảng nổi trên trang Studio
};

// ---------------- log & giao diện ----------------
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
  state.logLines.push(line);
  if (state.logLines.length > 300) state.logLines.splice(0, state.logLines.length - 300);
  pushOverlay();
}

// ---------------- bảng nổi trên trang Studio (overlay.js) ----------------
function overlayData() {
  return {
    running: state.running,
    canStart: !state.running && !!state.jobs.length,
    source: state.source?.name || "",
    jobs: state.jobs.map((j, i) => ({ n: i + 1, title: j.title, file: j.file, status: j.status || "pending", step: j.step, url: j.url, error: j.error })),
    logs: state.logLines.slice(-200),
  };
}

let overlayTimer = null;
function pushOverlay() {
  if (overlayTimer) return;
  overlayTimer = setTimeout(async () => {
    overlayTimer = null;
    const data = overlayData();
    for (const t of await chrome.tabs.query({ url: "https://studio.youtube.com/*" }).catch(() => [])) {
      chrome.tabs.sendMessage(t.id, { cmd: "overlay", data }).catch(() => {});
    }
  }, 150);
}

const STATUS_LABEL = { pending: "Chờ đăng", running: "Đang đăng", done: "Đã đăng", scheduled: "Đã lên lịch", error: "Lỗi", skip: "Bỏ qua" };

function render() {
  const tbody = $("jobs").querySelector("tbody");
  tbody.innerHTML = "";
  if (!state.jobs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Chưa có dữ liệu</td></tr>`;
    return;
  }
  state.jobs.forEach((j, i) => {
    const tr = document.createElement("tr");
    const status = j.status || "pending";
    const problems = validate(j);
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="title"></td>
      <td></td>
      <td>${j.schedule ? `⏰ ${j.schedule}` : j.visibility}</td>
      <td class="status-${status}">${STATUS_LABEL[status] || status}${j.step ? ` · ${j.step}` : ""}</td>
      <td>${j.url ? `<a href="${j.url}" target="_blank">${j.url.replace(/^https?:\/\//, "")}</a>` : ""}</td>`;
    tr.children[1].textContent = j.title;
    if (problems.length) {
      const p = document.createElement("div");
      p.className = "invalid";
      p.textContent = problems.join("; ");
      tr.children[1].appendChild(p);
    }
    if (j.error) {
      const p = document.createElement("div");
      p.className = "invalid";
      p.textContent = j.error;
      tr.children[1].appendChild(p);
    }
    tr.children[2].textContent = j.file;
    tbody.appendChild(tr);
  });
  $("start").disabled = state.running || !state.jobs.length;
  $("stop").disabled = !state.running;
  pushOverlay();
}

// ---------------- cài đặt ----------------
function buildProviderRows() {
  const tbody = $("providers").querySelector("tbody");
  tbody.innerHTML = "";
  $("primary").innerHTML = "";
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.label}</td>
      <td><input type="password" autocomplete="off" data-p="${id}" data-f="key" placeholder="${p.keyHint}"></td>
      <td><input data-p="${id}" data-f="model" placeholder="${p.model}"></td>
      <td><input data-p="${id}" data-f="baseUrl" placeholder="${p.baseUrl}"></td>`;
    tbody.appendChild(tr);
    $("primary").add(new Option(p.label, id));
  }
}

const aiReady = () => state.settings.aiEnabled && configuredProviders(state.settings.ai).length > 0;

async function loadSettings() {
  const s = await chrome.storage.local.get(["ai", "aiEnabled", "channelId", "maxAi", "apiKey", "model"]);
  // Bản 0.1 chỉ có Claude: chuyển apiKey/model cũ sang cấu trúc mới.
  const ai = s.ai || { providers: s.apiKey ? { anthropic: { key: s.apiKey, model: s.model } } : {}, order: [] };
  state.settings = { aiEnabled: true, maxAi: 8, ...s, ai };
  buildProviderRows();
  for (const input of document.querySelectorAll("#providers input")) {
    input.value = ai.providers?.[input.dataset.p]?.[input.dataset.f] || "";
  }
  $("primary").value = ai.order?.[0] || Object.keys(PROVIDERS).find((id) => ai.providers?.[id]?.key) || "anthropic";
  $("aiEnabled").checked = !!state.settings.aiEnabled;
  $("channelId").value = state.settings.channelId || "";
  $("maxAi").value = state.settings.maxAi;
}

async function saveSettings() {
  const providers = {};
  for (const input of document.querySelectorAll("#providers input")) {
    const v = input.value.trim();
    if (v) (providers[input.dataset.p] ||= {})[input.dataset.f] = v;
  }
  const primary = $("primary").value;
  const order = [primary, ...Object.keys(PROVIDERS).filter((id) => id !== primary)];
  state.settings = {
    ai: { providers, order },
    aiEnabled: $("aiEnabled").checked,
    channelId: $("channelId").value.trim(),
    maxAi: Math.max(1, Math.min(20, parseInt($("maxAi").value, 10) || 8)),
  };
  await chrome.storage.local.remove(["apiKey", "model"]);
  await chrome.storage.local.set(state.settings);
  const ready = configuredProviders(state.settings.ai).map((p) => p.label);
  log(`Đã lưu cài đặt. AI dùng được (theo thứ tự): ${ready.join(" → ") || "chưa có key nào"}`);
}

// Gửi một tình huống giả cho từng AI có key để kiểm tra key/model/Base URL.
async function testAi() {
  await saveSettings();
  const fake = {
    job: { title: "Test", visibility: "private", tags: [] },
    failure: { id: "show-more", label: "Mở phần cài đặt nâng cao", message: "Không thấy nút Show more", index: 7 },
    snapshot: { url: "https://studio.youtube.com/", heading: "Video details", elements: [{ i: 0, tag: "ytcp-button", id: "toggle-button", text: "Show more" }] },
    history: [],
  };
  for (const p of configuredProviders(state.settings.ai)) {
    try {
      const act = await askAI({ ...fake, aiSettings: { providers: { [p.id]: state.settings.ai.providers[p.id] }, order: [p.id] }, screenshot: null });
      log(`✓ ${p.label} (${p.model}): ${act.action}${act.index != null ? ` #${act.index}` : ""} — ${act.reason}`);
    } catch (e) {
      log(`✗ ${p.label}: ${e.message}`);
    }
  }
}

// ---------------- thư mục & queue.json ----------------
const DB = "ytu";
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function pickFolder() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await idb("readwrite", (s) => s.put(handle, "root"));
  await useFolder(handle);
}

async function restoreFolder() {
  const handle = await idb("readonly", (s) => s.get("root")).catch(() => null);
  if (!handle) return;
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") return useFolder(handle);
  state.root = handle;
  $("folder").textContent = `${handle.name} (cần cấp lại quyền)`;
  $("regrant").hidden = false;
}

async function regrant() {
  if (!state.root) return;
  if ((await state.root.requestPermission({ mode: "readwrite" })) === "granted") {
    $("regrant").hidden = true;
    await useFolder(state.root);
  }
}

async function useFolder(handle) {
  state.root = handle;
  $("folder").textContent = handle.name;
  // Tìm nguồn nội dung trong thư mục: ưu tiên noi-dung-youtube.xlsx → file .xlsx khác → queue.json
  const sources = [];
  for await (const [name, h] of handle.entries()) {
    if (h.kind !== "file" || name.startsWith("~$")) continue; // ~$… là file khoá Excel tạo khi đang mở
    if (/\.xlsx$/i.test(name)) sources.push({ kind: "xlsx", name });
    else if (name === "queue.json") sources.push({ kind: "json", name });
  }
  const rank = (s) => (s.name === "noi-dung-youtube.xlsx" ? 0 : s.kind === "xlsx" ? 1 : 2);
  sources.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const sel = $("source");
  sel.innerHTML = "";
  sources.forEach((src, i) => sel.add(new Option(src.name, i)));
  sel.disabled = !sources.length;
  sel.onchange = () => {
    state.source = sources[+sel.value];
    readQueue();
  };
  $("reload").disabled = !sources.length;
  state.source = sources[0] || null;
  if (!state.source) {
    state.jobs = [];
    log("Thư mục chưa có file .xlsx hay queue.json — tạo bằng tools/make_sheet.mjs");
    render();
    return;
  }
  await readQueue();
}

async function fileHandle(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  let dir = state.root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function readQueue() {
  state.files.clear();
  const src = state.source;
  if (!src) return;
  try {
    if (src.kind === "xlsx") {
      const { jobs } = await readSheet(await fileHandle(src.name));
      state.jobs = jobs.map((j, i) => ({ ...j, id: `job${i}`, index: i }));
    } else {
      state.queue = JSON.parse(await (await (await fileHandle(src.name)).getFile()).text());
      const d = state.queue.defaults || {};
      state.jobs = (state.queue.videos || []).map((v, i) => ({
        visibility: "private",
        madeForKids: false,
        alteredContent: false,
        videoLanguage: null,
        titleLanguage: null,
        tags: [],
        ...d,
        ...v,
        tags: [...new Set([...(d.tags || []), ...(v.tags || [])])],
        id: `job${i}`,
        index: i,
      }));
    }
  } catch (e) {
    state.jobs = [];
    log(`Không đọc được ${src.name}: ${e.message}`);
    render();
    return;
  }
  const count = (st) => state.jobs.filter((j) => j.status === st).length;
  log(`Đã đọc ${src.name}: ${state.jobs.length} video — ${count("pending")} chờ đăng, ${count("done")} đã đăng, ${count("scheduled")} đã lên lịch, ${count("error")} lỗi, ${count("skip")} bỏ qua`);
  render();
}

// Ghi trạng thái/link về nguồn. Excel đang mở thì Windows khoá file → giữ kết quả, báo người dùng đóng Excel rồi bấm "Ghi kết quả vào file".
async function writeQueue() {
  const src = state.source;
  try {
    if (src.kind === "xlsx") {
      await writeResults(await fileHandle(src.name), state.jobs);
    } else {
      state.jobs.forEach((j) => {
        const v = state.queue.videos[j.index];
        for (const k of ["status", "url", "error", "uploadedAt"]) {
          if (j[k] != null && j[k] !== "") v[k] = j[k];
          else delete v[k];
        }
      });
      const w = await (await fileHandle(src.name)).createWritable();
      await w.write(JSON.stringify(state.queue, null, 2) + "\n");
      await w.close();
    }
    state.jobs.forEach((j) => (j.dirty = false));
    $("writeBack").disabled = true;
  } catch (e) {
    $("writeBack").disabled = false;
    const locked = /NoModificationAllowed|NotReadable|InvalidState|being used|locked/i.test(`${e.name} ${e.message}`);
    log(`⚠ Chưa ghi được kết quả vào ${src.name}${locked ? " — file đang mở trong Excel? Đóng Excel rồi bấm \"Ghi kết quả vào file\"" : `: ${e.message}`}`);
  }
}

function validate(j) {
  const p = [];
  if (!j.file) p.push("thiếu file");
  if (!j.title) p.push("thiếu tiêu đề");
  if ((j.title || "").length > 100) p.push(`tiêu đề ${j.title.length}/100 ký tự`);
  if ((j.description || "").length > 5000) p.push("mô tả > 5000 ký tự");
  if (/[<>]/.test((j.title || "") + (j.description || ""))) p.push("YouTube không cho dùng < >");
  if ((j.tags || []).join(",").length > 500) p.push("tag > 500 ký tự");
  if (!["public", "unlisted", "private"].includes(String(j.visibility).toLowerCase())) p.push("visibility sai");
  if (j.schedule && !["done", "scheduled", "skip"].includes(j.status)) {
    const m = String(j.schedule).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!m) p.push(`lịch đăng sai định dạng "${j.schedule}" (cần YYYY-MM-DD HH:mm)`);
    else if (new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) < Date.now() + 15 * 60 * 1000) p.push("lịch đăng phải sau hiện tại ít nhất 15 phút");
  }
  return p;
}

// ---------------- phục vụ file cho content script ----------------
async function getJobFile(jobId, kind) {
  const key = `${jobId}:${kind}`;
  if (!state.files.has(key)) {
    const job = state.jobs.find((j) => j.id === jobId);
    const rel = kind === "video" ? job.file : job.thumbnail;
    state.files.set(key, await (await fileHandle(rel)).getFile());
  }
  return state.files.get(key);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "file-meta") {
    getJobFile(msg.jobId, msg.kind)
      .then((f) => sendResponse({ name: f.name, size: f.size, type: f.type }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === "file-chunk") {
    getJobFile(msg.jobId, msg.kind)
      .then((f) => f.slice(msg.offset, msg.offset + msg.length).arrayBuffer())
      .then((buf) => sendResponse({ data: toBase64(buf) }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === "job-event") {
    if (!msg.quiet || msg.kind !== "log") onJobEvent(msg);
  }
  if (msg?.type === "overlay-sync") {
    sendResponse(overlayData());
    return;
  }
  if (msg?.type === "overlay-cmd") {
    if (msg.action === "start" && !state.running) $("start").click();
    if (msg.action === "stop" && state.running) $("stop").click();
    sendResponse({ ok: true });
  }
});

function onJobEvent(ev) {
  const job = state.jobs.find((j) => j.id === ev.jobId);
  if (ev.kind === "log") log(`  ${ev.message}`);
  if (ev.kind === "step" && job) {
    job.step = ev.label;
    log(`#${job.index + 1} → ${ev.label}`);
    render();
  }
  if (ev.kind === "published" && job) {
    job.published = true;
    if (ev.url) job.publishedUrl = ev.url;
  }
  if (ev.kind === "done" || ev.kind === "error") state.waiters.get(ev.jobId)?.(ev);
}

// ---------------- tab YouTube Studio ----------------
async function studioTab() {
  const tabs = await chrome.tabs.query({ url: "https://studio.youtube.com/*" });
  if (tabs.length) return tabs.find((t) => t.active) || tabs[0];
  log("Chưa có tab YouTube Studio — mở tab mới");
  return chrome.tabs.create({ url: "https://studio.youtube.com/", active: true });
}

function waitTabComplete(tabId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Trang Studio tải quá lâu"));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function waitContent(tabId) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await send(tabId, { cmd: "ping" });
      if (r?.ok) return r;
    } catch (_) {
      if (i === 10) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["studio-steps.js", "content.js", "overlay.js"] }).catch(() => {});
      }
    }
    await sleep(500);
  }
  throw new Error("Không kết nối được với tab Studio (thử tải lại tab)");
}

async function channelId(tab) {
  if (state.settings.channelId) return state.settings.channelId;
  const fromUrl = (u) => (u || "").match(/\/channel\/(UC[\w-]{10,})/)?.[1];
  let id = fromUrl(tab.url);
  if (!id) {
    await chrome.tabs.update(tab.id, { url: "https://studio.youtube.com/" });
    await waitTabComplete(tab.id);
    for (let i = 0; i < 20 && !id; i++) {
      await sleep(500);
      id = fromUrl((await chrome.tabs.get(tab.id)).url);
    }
  }
  if (!id) throw new Error("Không nhận ra Channel ID — điền tay trong Cài đặt");
  return id;
}

// Tab Studio phải là tab đang hiện trong cửa sổ của nó, nếu không Chrome hãm timer và tool chạy rất chậm.
async function keepStudioVisible(tab) {
  const me = await chrome.tabs.getCurrent();
  if (me && me.windowId === tab.windowId) {
    await chrome.windows.create({ tabId: me.id, width: 760, height: 900 });
    log("Đã tách trang điều khiển ra cửa sổ riêng để tab Studio luôn hiển thị");
  }
  await chrome.tabs.update(tab.id, { active: true });
}

async function captureStudio(tab) {
  try {
    const t = await chrome.tabs.get(tab.id);
    if (!t.active) return null;
    return await chrome.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {
    return null; // không có quyền chụp → AI chỉ dựa vào danh sách phần tử
  }
}

// ---------------- chạy ----------------
function runSteps(tabId, job, fromStep) {
  return new Promise(async (resolve, reject) => {
    const docId = (await send(tabId, { cmd: "ping" }).catch(() => null))?.docId;
    let settled = false;
    let checking = false;
    // Studio đổi URL kiểu SPA (vd sau khi đóng hộp "Video published") cũng báo status "loading" — chỉ coi là tải lại
    // khi content script trả về DOC_ID khác (trang mới) hoặc không trả lời.
    // Tải lại thật = mất trạng thái hộp thoại; không tự chạy lại để tránh đăng trùng.
    const onNav = async (id, info) => {
      if (id !== tabId || info.status !== "loading" || checking || settled) return;
      checking = true;
      await sleep(2000);
      const r = await send(tabId, { cmd: "ping" }).catch(() => null);
      checking = false;
      if (settled || (docId && r?.docId === docId)) return;
      finish();
      if (job.published && job.publishedUrl) {
        log("  Tab Studio tải lại sau khi đã bấm Publish — vẫn tính là đã đăng");
        resolve({ kind: "done", url: job.publishedUrl });
      } else if (job.published) {
        reject(new Error("Đã bấm Publish nhưng tab tải lại trước khi lấy được link — lấy link trong mục Nội dung, đừng chạy lại kẻo đăng trùng"));
      } else {
        reject(new Error("Tab Studio bị tải lại giữa chừng — kiểm tra mục Nội dung xem có bản nháp dở không rồi chạy lại"));
      }
    };
    const finish = () => {
      settled = true;
      state.waiters.delete(job.id);
      chrome.tabs.onUpdated.removeListener(onNav);
    };
    state.waiters.set(job.id, (ev) => {
      if (settled) return;
      finish();
      resolve(ev);
    });
    chrome.tabs.onUpdated.addListener(onNav);
    try {
      await send(tabId, { cmd: "run", job, fromStep });
    } catch (e) {
      finish();
      reject(e);
    }
  });
}

async function aiRecover(tab, job, failure) {
  const s = state.settings;
  const history = [];
  let snap = failure.snapshot;
  for (let n = 0; n < s.maxAi; n++) {
    const shot = await captureStudio(tab);
    const act = await askAI({ aiSettings: s.ai, job, failure, snapshot: snap, screenshot: shot, history, log });
    log(`  ${act.provider}: ${act.action}${act.index != null ? ` #${act.index}` : ""}${act.text ? ` "${act.text.slice(0, 40)}"` : ""} — ${act.reason}`);
    history.push({ action: act.action, index: act.index, reason: act.reason });
    if (act.action === "retry_step") return failure.index;
    if (act.action === "skip_step") {
      if (failure.optional) return failure.index + 1;
      history.push({ note: "skip_step bị từ chối: bước này bắt buộc" });
      continue;
    }
    if (act.action === "give_up") throw new Error(`AI: cần người xử lý — ${act.reason}`);
    const r = await send(tab.id, { cmd: "ai-action", action: act });
    if (!r?.ok) history.push({ error: r?.error || "thao tác lỗi" });
    snap = await send(tab.id, { cmd: "snapshot" });
  }
  return failure.index; // hết lượt: để tool thử lại bước một lần nữa
}

async function runJob(tab, chId, job) {
  job.published = false;
  job.publishedUrl = "";
  await chrome.tabs.update(tab.id, { url: `https://studio.youtube.com/channel/${chId}/videos/upload?d=ud` });
  await waitTabComplete(tab.id);
  await waitContent(tab.id);

  let fromStep = 0;
  let aiRounds = 0;
  const failsAt = {};
  for (;;) {
    const ev = await runSteps(tab.id, job, fromStep);
    if (ev.kind === "done") {
      // Tên playlist thật đã tick trên kênh — ghi lại vào cột Playlist (Excel ghi tên cũ / "+Tên mới" / mã PL… đều thành tên).
      if (ev.playlists?.length) job.playlistsDone = ev.playlists;
      return ev.url;
    }

    log(`  ✗ ${ev.label}: ${ev.message}`);
    failsAt[ev.index] = (failsAt[ev.index] || 0) + 1;
    if (ev.optional && !aiReady()) {
      log("  Bước không bắt buộc — bỏ qua");
      fromStep = ev.index + 1;
      continue;
    }
    if (!aiReady()) throw new Error(`${ev.label}: ${ev.message}`);
    if (failsAt[ev.index] > 3 || ++aiRounds > 5) throw new Error(`Kẹt ở "${ev.label}" sau nhiều lần AI hỗ trợ: ${ev.message}`);
    log(`  Nhờ AI gỡ bước "${ev.label}" (lần ${aiRounds})`);
    fromStep = await aiRecover(tab, job, ev);
  }
}

async function start() {
  const todo = state.jobs.filter((j) => !["done", "scheduled", "skip"].includes(j.status) && ($("retryFailed").checked || j.status !== "error"));
  const bad = todo.filter((j) => validate(j).length);
  if (bad.length) {
    log(`Có ${bad.length} video chưa hợp lệ — sửa queue.json trước (xem dòng màu đỏ)`);
    return;
  }
  if (!todo.length) {
    log("Không còn video nào cần đăng");
    return;
  }
  state.running = true;
  state.stopRequested = false;
  render();
  try {
    let tab = await studioTab();
    await keepStudioVisible(tab);
    const chId = await channelId(tab);
    log(`Kênh ${chId} — đăng ${todo.length} video`);
    for (const job of todo) {
      if (state.stopRequested) break;
      job.status = "running";
      job.dirty = true;
      job.error = "";
      render();
      try {
        tab = await chrome.tabs.get(tab.id);
        job.url = await runJob(tab, chId, job);
        job.status = job.schedule ? "scheduled" : "done";
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        job.uploadedAt = job.schedule || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        log(`✓ #${job.index + 1} ${job.schedule ? `đã hẹn ${job.schedule} — ` : ""}${job.url}`);
      } catch (e) {
        job.status = "error";
        job.error = e.message;
        log(`✗ #${job.index + 1} dừng: ${e.message}`);
      }
      job.step = "";
      render();
      await writeQueue();
    }
  } catch (e) {
    log(`Lỗi: ${e.message}`);
  } finally {
    state.running = false;
    render();
    log("Kết thúc lượt chạy");
  }
}

async function selfCheckStudio() {
  try {
    const tab = await studioTab();
    await waitContent(tab.id);
    const r = await send(tab.id, { cmd: "self-check" });
    log(`Selector trên ${tab.url}:\n${Object.entries(r).map(([k, v]) => `  ${v ? "✓" : "·"} ${k}`).join("\n")}`);
  } catch (e) {
    log(`Kiểm tra lỗi: ${e.message}`);
  }
}

// ---------------- gắn sự kiện ----------------
$("pick").onclick = () => pickFolder().catch((e) => log(e.message));
$("regrant").onclick = () => regrant().catch((e) => log(e.message));
$("reload").onclick = () => readQueue();
$("writeBack").onclick = () => writeQueue();
$("start").onclick = () => start();
$("stop").onclick = () => {
  state.stopRequested = true;
  log("Sẽ dừng sau video hiện tại");
};
$("check").onclick = () => selfCheckStudio();
$("save").onclick = () => saveSettings();
$("testAi").onclick = () => testAi().catch((e) => log(e.message));

await loadSettings();
await restoreFolder();
render();
