// Các bước tự động trên hộp thoại "Upload videos" của YouTube Studio.
// Không dùng API chrome.* để có thể chạy/thử thẳng trong trang. content.js nối với trang điều khiển.
//
// Mỗi bước: { id, label, optional?, run(ctx) }. run() ném StepError khi không làm được;
// content.js bắt lỗi, gửi ảnh chụp DOM cho trang điều khiển để nhờ AI gỡ rồi chạy tiếp từ bước đó.
(() => {
  if (window.__ytu) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  class StepError extends Error {}

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  const $ = (sel, root = document) => [...root.querySelectorAll(sel)].find(visible) || null;
  const $all = (sel, root = document) => [...root.querySelectorAll(sel)].filter(visible);

  async function waitFor(fn, { timeout = 20000, interval = 300, what = "phần tử" } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (_) { /* thử lại */ }
      await sleep(interval);
    }
    throw new StepError(`Hết thời gian chờ ${Math.round(timeout / 1000)}s: ${what}`);
  }

  function click(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
  }

  const isChecked = (el) =>
    el && (el.getAttribute("aria-checked") === "true" || el.hasAttribute("checked") || el.checked === true);

  const isDisabled = (el) =>
    !el || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled");

  function setFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dropFiles(target, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }

  // Ô nhập của Studio là contenteditable; execCommand sinh đúng sự kiện input mà Studio lắng nghe.
  async function setEditable(el, text) {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    el.blur();
  }

  const sameText = (a, b) => norm(a) === norm(b);

  // Ghi chữ rồi kiểm tra lại sau một nhịp: Studio có thể ghi đè nếu form chưa sẵn sàng.
  async function setEditableVerified(getEl, text, what) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const el = await waitFor(getEl, { what });
      await setEditable(el, text);
      await sleep(1500);
      const now = getEl();
      if (now && sameText(now.innerText, text)) return;
      await sleep(1500 * attempt);
    }
    throw new StepError(`Không ghi được ${what} (Studio ghi đè hoặc ô không nhận chữ)`);
  }

  function leafWithText(re, root = document) {
    return [...root.querySelectorAll("*")].find(
      (e) => e.childElementCount === 0 && visible(e) && re.test(norm(e.textContent))
    );
  }

  const toRegexList = (v) =>
    (Array.isArray(v) ? v : [v]).filter(Boolean).map((s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));

  // Dropdown của Studio: bấm vào ô có nhãn labelRe, chọn mục khớp một trong optionRes.
  async function selectDropdown(labelRe, optionRes, what) {
    const label = await waitFor(() => leafWithText(labelRe), { what: `ô "${what}"`, timeout: 10000 });
    const trigger =
      label.closest("ytcp-form-select, ytcp-form-language-input, ytcp-dropdown-trigger, ytcp-select, [role=button]") ||
      label.parentElement;
    const current = norm(trigger.innerText).replace(norm(label.textContent), "").trim();
    if (optionRes.some((re) => re.test(current))) return;

    click(trigger);
    const option = await waitFor(
      () =>
        [...document.querySelectorAll("tp-yt-paper-item, [role=option], ytcp-text-menu tp-yt-paper-item")]
          .filter((e) => e.isConnected && e.getClientRects().length)
          .find((e) => optionRes.some((re) => re.test(norm(e.innerText || e.textContent)))),
      { what: `mục ngôn ngữ trong "${what}"`, timeout: 8000 }
    );
    option.scrollIntoView({ block: "center" });
    await sleep(400);
    option.click();
    await sleep(1000);
    const after = norm(trigger.innerText).replace(norm(label.textContent), "").trim();
    if (!optionRes.some((re) => re.test(after))) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      throw new StepError(`Chọn "${what}" chưa ăn (đang là "${after}")`);
    }
  }

  const titleBox = () => $("#title-textarea #textbox") || $("ytcp-social-suggestions-textbox#title-textarea [contenteditable]");
  const descBox = () => $("#description-textarea #textbox") || $("ytcp-social-suggestions-textbox#description-textarea [contenteditable]");
  const uploadInput = () => document.querySelector('input[type=file][name="Filedata"]');

  const STEPS = [
    {
      id: "open-dialog",
      label: "Mở hộp thoại Upload videos",
      async run() {
        if (uploadInput() || titleBox()) return;
        const create =
          $("#create-icon") ||
          $all("button, ytcp-button").find((b) => /^(create|tạo)$/i.test(b.getAttribute("aria-label") || norm(b.innerText)));
        if (create) {
          click(create);
          await sleep(800);
          const item = $("#text-item-0") || [...document.querySelectorAll("tp-yt-paper-item")].find((e) => /upload videos|tải video lên/i.test(norm(e.innerText)));
          if (item) click(item);
        }
        await waitFor(uploadInput, { what: "ô chọn file video", timeout: 15000 });
      },
    },
    {
      id: "select-video",
      label: "Chọn file video",
      async run(ctx) {
        if (titleBox()) return; // đã chọn file ở lần chạy trước
        const file = await ctx.getFile("video");
        ctx.log(`Đã đọc ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`);
        setFiles(uploadInput(), [file]);
        try {
          await waitFor(titleBox, { what: "form chi tiết video", timeout: 20000 });
        } catch (_) {
          const zone = $("ytcp-uploads-file-picker") || $("#content");
          if (zone) dropFiles(zone, [file]);
          await waitFor(titleBox, { what: "form chi tiết video (sau khi thả file)", timeout: 20000 });
        }
      },
    },
    {
      id: "wait-form",
      label: "Chờ form sẵn sàng",
      async run() {
        // Studio tự điền tiêu đề = tên file khi form xong; gõ trước lúc đó sẽ bị ghi đè.
        await waitFor(() => titleBox() && norm(titleBox().innerText).length > 0, { what: "tiêu đề tự điền", timeout: 30000 });
        await sleep(1500);
      },
    },
    {
      id: "title",
      label: "Nhập tiêu đề",
      async run(ctx) {
        await setEditableVerified(titleBox, ctx.job.title, "tiêu đề");
      },
    },
    {
      id: "description",
      label: "Nhập mô tả",
      async run(ctx) {
        if (!ctx.job.description) return;
        await setEditableVerified(descBox, ctx.job.description, "mô tả");
      },
    },
    {
      id: "thumbnail",
      label: "Tải thumbnail",
      optional: true,
      async run(ctx) {
        if (!ctx.job.thumbnail) return;
        const input = document.querySelector("input#file-loader");
        if (!input) {
          ctx.log("Không thấy ô thumbnail (kênh có thể chưa xác minh) — bỏ qua");
          return;
        }
        setFiles(input, [await ctx.getFile("thumbnail")]);
        await sleep(2500);
      },
    },
    {
      id: "audience",
      label: "Chọn đối tượng (dành cho trẻ em?)",
      async run(ctx) {
        const name = ctx.job.madeForKids ? "VIDEO_MADE_FOR_KIDS_MFK" : "VIDEO_MADE_FOR_KIDS_NOT_MFK";
        const radio = await waitFor(() => document.querySelector(`tp-yt-paper-radio-button[name="${name}"]`), { what: "nút chọn đối tượng" });
        if (!isChecked(radio)) click(radio);
        await waitFor(() => isChecked(radio), { what: "đối tượng được chọn", timeout: 5000 });
      },
    },
    {
      id: "show-more",
      label: "Mở phần cài đặt nâng cao",
      async run() {
        if (tagsInput()) return;
        const btn = $("#toggle-button") || [...document.querySelectorAll("ytcp-button, button")].find((b) => /show advanced settings|show more|hiện thêm/i.test(b.getAttribute("aria-label") || norm(b.innerText)));
        if (!btn) throw new StepError('Không thấy nút "Show more"');
        click(btn);
        await waitFor(tagsInput, { what: "ô tag (cài đặt nâng cao)", timeout: 8000 });
      },
    },
    {
      id: "altered-content",
      label: "Khai báo nội dung có dùng AI",
      optional: true,
      async run(ctx) {
        const want = ctx.job.alteredContent ? "yes" : "no";
        // Tên thật (đã kiểm tra trên Studio): VIDEO_HAS_ALTERED_CONTENT_YES / _NO.
        const radios = $all("tp-yt-paper-radio-button").filter(
          (r) => !/kids|trẻ em|paid|promotion|quảng cáo|remix/i.test(norm(r.innerText) + " " + (r.getAttribute("name") || ""))
        );
        const byName = radios.find((r) => new RegExp(`ALTERED.*${want}`, "i").test(r.getAttribute("name") || ""));
        const byText = radios.find((r) =>
          want === "yes" ? /^(yes|có)\b/i.test(norm(r.innerText)) : /^(no|không)\b/i.test(norm(r.innerText))
        );
        const radio = byName || byText;
        if (!radio) throw new StepError("Không thấy mục khai báo nội dung AI");
        if (!isChecked(radio)) click(radio);
        await waitFor(() => isChecked(radio), { what: "mục AI được chọn", timeout: 5000 });
      },
    },
    {
      id: "tags",
      label: "Thêm tag",
      async run(ctx) {
        const tags = ctx.job.tags || [];
        if (!tags.length) return;
        const input = await waitFor(tagsInput, { what: "ô tag" });
        input.focus();
        document.execCommand("insertText", false, tags.join(",") + ",");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        await sleep(800);
        const chips = $all("ytcp-chip", input.closest("ytcp-free-text-chip-bar") || document);
        if (chips.length < Math.min(tags.length, 1)) throw new StepError("Tag không được thêm");
      },
    },
    {
      id: "video-language",
      label: "Chọn ngôn ngữ video",
      async run(ctx) {
        if (!ctx.job.videoLanguage) return;
        await selectDropdown(/^(video language|ngôn ngữ (của )?video)$/i, toRegexList(ctx.job.videoLanguage), "Video language");
      },
    },
    {
      id: "title-language",
      label: "Chọn ngôn ngữ tiêu đề & mô tả",
      async run(ctx) {
        // Bắt buộc: để mặc định English thì kênh bật dịch tự động sẽ ghi đè tiêu đề/mô tả bằng bản tiếng Anh.
        if (!ctx.job.titleLanguage) return;
        await selectDropdown(/^(title and description language|ngôn ngữ (của )?tiêu đề và (phần )?mô tả)$/i, toRegexList(ctx.job.titleLanguage), "Title and description language");
      },
    },
    {
      id: "to-visibility",
      label: "Sang bước Visibility",
      async run() {
        for (let i = 0; i < 5 && !visibilityRadio("PUBLIC"); i++) {
          const next = $("#next-button");
          if (!next) break;
          if (!isDisabled(next)) click(next);
          await sleep(1500);
        }
        await waitFor(() => visibilityRadio("PUBLIC"), { what: "màn hình Visibility", timeout: 10000 });
      },
    },
    {
      id: "visibility",
      label: "Chọn chế độ hiển thị",
      async run(ctx) {
        const name = { public: "PUBLIC", unlisted: "UNLISTED", private: "PRIVATE" }[(ctx.job.visibility || "private").toLowerCase()];
        if (!name) throw new StepError(`visibility không hợp lệ: ${ctx.job.visibility}`);
        const radio = await waitFor(() => visibilityRadio(name), { what: `nút ${name}` });
        if (!isChecked(radio)) click(radio);
        await waitFor(() => isChecked(radio), { what: `${name} được chọn`, timeout: 5000 });
      },
    },
    {
      id: "wait-upload",
      label: "Chờ tải video lên xong",
      async run(ctx) {
        let lastMsg = "";
        await waitFor(
          () => {
            const msg = norm(($("ytcp-video-upload-progress") || {}).innerText || "");
            if (msg && msg !== lastMsg) {
              lastMsg = msg;
              ctx.log(msg);
            }
            const done = $("#done-button");
            return done && !isDisabled(done) && !/uploading|đang tải lên/i.test(msg);
          },
          { what: "tải video lên", timeout: 60 * 60 * 1000, interval: 2000 }
        );
      },
    },
    {
      id: "publish",
      label: "Đăng / lưu video",
      async run(ctx) {
        const link = $('a[href*="youtu.be/"]') || $('a[href*="youtube.com/shorts/"]');
        if (link) ctx.result.url = link.href;
        const done = await waitFor(() => $("#done-button"), { what: "nút Publish/Save" });
        click(done);
        await waitFor(
          () => $("ytcp-video-share-dialog") || $("ytcp-prechecks-warning-dialog") || !$("ytcp-uploads-dialog"),
          { what: "xác nhận đã đăng", timeout: 30000 }
        );
        const warn = $("ytcp-prechecks-warning-dialog");
        if (warn) {
          const ok = [...warn.querySelectorAll("ytcp-button, button")].find((b) => /publish|đăng/i.test(norm(b.innerText)));
          if (!ok) throw new StepError("Studio hiện cảnh báo trước khi đăng — cần người xem");
          click(ok);
          await sleep(2000);
        }
        const share = $("ytcp-video-share-dialog");
        const shareLink = share && share.querySelector('a[href*="youtu"]');
        if (shareLink) ctx.result.url = shareLink.href;
        if (!ctx.result.url) throw new StepError("Đã bấm đăng nhưng không lấy được link video");
        const close = share && ($("#close-button", share) || [...share.querySelectorAll("ytcp-button, button")].find((b) => /close|đóng/i.test(norm(b.innerText))));
        if (close) click(close);
      },
    },
  ];

  function tagsInput() {
    return $("#tags-container input#text-input") || $("ytcp-free-text-chip-bar input#text-input") || $("ytcp-free-text-chip-bar input");
  }

  function visibilityRadio(name) {
    return document.querySelector(`tp-yt-paper-radio-button[name="${name}"]`);
  }

  // ---------- Dành cho AI hỗ trợ khi kẹt ----------
  const INTERACTIVE =
    "button, [role=button], ytcp-button, tp-yt-paper-radio-button, tp-yt-paper-checkbox, tp-yt-paper-item, [role=option], [role=radio], [role=menuitem], [role=tab], input, textarea, [contenteditable=true], a[href], ytcp-dropdown-trigger";
  let refs = [];

  function snapshot() {
    const root = $("ytcp-uploads-dialog") || document.body;
    const scopes = [root, ...$all("tp-yt-paper-dialog, ytcp-dialog, tp-yt-iron-dropdown")].filter((v, i, a) => a.indexOf(v) === i);
    const seen = new Set();
    refs = [];
    const items = [];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll(INTERACTIVE)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        refs.push(el);
        items.push({
          i: refs.length - 1,
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          name: el.getAttribute("name") || undefined,
          role: el.getAttribute("role") || undefined,
          aria: el.getAttribute("aria-label") || undefined,
          text: norm(el.innerText || el.value || el.textContent).slice(0, 90) || undefined,
          checked: isChecked(el) || undefined,
          disabled: isDisabled(el) || undefined,
        });
        if (items.length >= 160) break;
      }
    }
    const heading = norm(($("ytcp-uploads-dialog #dialog-title") || {}).innerText || document.title);
    return { url: location.href, heading, elements: items };
  }

  const FORBIDDEN = /delete|xoá|xóa|remove video|discard|hủy tải|cancel upload/i;

  async function performAction(a) {
    const el = a.index != null ? refs[a.index] : null;
    if (a.index != null && !el) throw new Error(`Không có phần tử số ${a.index} (chụp lại DOM)`);
    if (el && FORBIDDEN.test(norm(el.innerText) + " " + (el.getAttribute("aria-label") || ""))) {
      throw new Error("Từ chối thao tác có thể xoá/huỷ video");
    }
    switch (a.action) {
      case "click":
        click(el);
        break;
      case "type":
        if (el.isContentEditable) await setEditable(el, a.text || "");
        else {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
          setter ? setter.call(el, a.text || "") : (el.value = a.text || "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        break;
      case "scroll":
        el.scrollIntoView({ block: "center" });
        break;
      case "key":
        (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: a.key || "Escape", bubbles: true }));
        break;
      case "wait":
        await sleep(Math.min(a.ms || 2000, 15000));
        break;
      default:
        throw new Error(`Thao tác không hỗ trợ: ${a.action}`);
    }
    await sleep(1200);
    return { ok: true };
  }

  // Kiểm tra selector mà không đăng gì (dùng trên trang upload hoặc trang sửa video).
  function selfCheck() {
    return {
      uploadInput: !!uploadInput(),
      titleBox: !!titleBox(),
      descBox: !!descBox(),
      thumbnailInput: !!document.querySelector("input#file-loader"),
      kidsRadio: !!document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'),
      showMore: !!($("#toggle-button")),
      tagsInput: !!tagsInput(),
      videoLanguageLabel: !!leafWithText(/^(video language|ngôn ngữ (của )?video)$/i),
      titleLanguageLabel: !!leafWithText(/^(title and description language|ngôn ngữ (của )?tiêu đề và (phần )?mô tả)$/i),
      nextButton: !!$("#next-button"),
      publicRadio: !!visibilityRadio("PUBLIC"),
      doneButton: !!$("#done-button"),
    };
  }

  window.__ytu = { STEPS, StepError, snapshot, performAction, selfCheck, sleep };
})();
