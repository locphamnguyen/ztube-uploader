// Cầu nối giữa trang điều khiển (uploader.html) và các bước trong studio-steps.js.
// Video/thumbnail nằm ở trang điều khiển (File System Access); content script xin từng khúc base64
// qua chrome.runtime rồi ghép lại thành File — không giới hạn dung lượng như công cụ upload qua CDP.
(() => {
  if (window.__ytuBridge) return;
  window.__ytuBridge = true;

  const { STEPS, snapshot, performAction, selfCheck } = window.__ytu;
  const CHUNK = 8 * 1024 * 1024;
  // Mỗi lần trang tải lại thật thì content script chạy lại với DOC_ID mới; Studio đổi URL kiểu SPA thì DOC_ID giữ nguyên.
  const DOC_ID = Math.random().toString(36).slice(2);
  let current = null; // { job, result, running }

  const emit = (event) => chrome.runtime.sendMessage({ type: "job-event", ...event }).catch(() => {});

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function getFile(jobId, kind) {
    const meta = await chrome.runtime.sendMessage({ type: "file-meta", jobId, kind });
    if (!meta || meta.error) throw new window.__ytu.StepError(meta?.error || `Không đọc được file ${kind}`);
    const parts = [];
    for (let offset = 0; offset < meta.size; offset += CHUNK) {
      const r = await chrome.runtime.sendMessage({ type: "file-chunk", jobId, kind, offset, length: CHUNK });
      if (!r || r.error) throw new window.__ytu.StepError(r?.error || "Đọc file bị lỗi giữa chừng");
      parts.push(b64ToBytes(r.data));
      emit({ jobId, kind: "log", message: `Đọc ${kind}: ${Math.min(100, Math.round(((offset + CHUNK) / meta.size) * 100))}%`, quiet: true });
    }
    return new File(parts, meta.name, { type: meta.type || "application/octet-stream" });
  }

  async function run(job, fromStep) {
    if (current?.running) return;
    if (!current || current.job.id !== job.id) current = { job, result: {}, running: false };
    current.running = true;
    const ctx = {
      job,
      result: current.result,
      getFile: (kind) => getFile(job.id, kind),
      log: (message) => emit({ jobId: job.id, kind: "log", message }),
      // Báo trang điều khiển: đã bấm Publish — tab có tải lại sau đó thì vẫn tính là đã đăng, không chạy lại kẻo trùng.
      published: () => emit({ jobId: job.id, kind: "published", url: current.result.url || null }),
    };
    for (let i = fromStep; i < STEPS.length; i++) {
      const step = STEPS[i];
      emit({ jobId: job.id, kind: "step", index: i, id: step.id, label: step.label });
      try {
        await step.run(ctx);
      } catch (e) {
        current.running = false;
        emit({
          jobId: job.id,
          kind: "error",
          index: i,
          id: step.id,
          label: step.label,
          optional: !!step.optional,
          message: e?.message || String(e),
          snapshot: snapshot(),
        });
        return;
      }
    }
    current.running = false;
    emit({ jobId: job.id, kind: "done", url: current.result.url || null, playlists: current.result.playlists || null });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.cmd) {
      case "ping":
        sendResponse({ ok: true, url: location.href, busy: !!current?.running, docId: DOC_ID });
        return;
      case "run":
        run(msg.job, msg.fromStep || 0);
        sendResponse({ started: true });
        return;
      case "snapshot":
        sendResponse(snapshot());
        return;
      case "self-check":
        sendResponse(selfCheck());
        return;
      case "ai-action":
        performAction(msg.action)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      case "steps":
        sendResponse(STEPS.map((s) => ({ id: s.id, label: s.label, optional: !!s.optional })));
        return;
    }
  });
})();
