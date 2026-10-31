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

  // ---------- Playlist (selector đã kiểm tra trên Studio 10/2026: ytcp-video-metadata-playlists → ytcp-playlist-dialog,
  // ô tìm input#search-input, mỗi dòng li có .label-text + #checkbox[role=checkbox], nút ytcp-button.done-button) ----------
  const playlistDialog = () =>
    [...document.querySelectorAll("ytcp-playlist-dialog")].find((d) => visible(d.querySelector("tp-yt-paper-dialog") || d));

  // So tên playlist: bỏ dấu tiếng Việt, hoa/thường, dấu câu ("Hướng dẫn ZCRM Web," ≡ "huong dan zcrm web").
  const foldName = (s) =>
    norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  // Ô Playlist trong Excel nhận: mã playlist (PL…), link có "list=PL…", hoặc tên.
  const playlistIdOf = (s) => (s.match(/[?&]list=([\w-]+)/) || s.match(/^(PL[\w-]{8,})$/) || [])[1] || null;

  // Danh sách playlist của kênh: iron-list giữ đủ { id, label, checked } kể cả dòng chưa vẽ (Studio 10/2026, mã ngắn
  // dạng "PLRUnAbkBHiDE" mở được youtube.com/playlist?list=…). Không đọc được thì lấy từ các dòng đang vẽ.
  function channelPlaylists(dlg) {
    const items = dlg.querySelector("tp-yt-iron-list")?.items;
    if (Array.isArray(items) && items.length && items[0].label != null)
      return items.map((it) => ({ id: it.id || null, label: norm(it.label) }));
    return [...dlg.querySelectorAll("#playlists-list li")].map((li) => ({
      id: li.querySelector("ytcp-checkbox-lit")?.getAttribute("test-id") || null,
      label: norm((li.querySelector(".label-text") || li).textContent),
    }));
  }

  // Tên trong Excel không trùng hẳn (playlist bị đổi tên, thêm/bớt chữ):
  //  1. "chứa trọn": mọi từ của tên này nằm trong tên kia (≥ 2 từ) — vd Excel "Hướng dẫn sử dụng ZCRM Web, Desktop"
  //     ⊇ kênh "Hướng dẫn ZCRM Web". Đúng MỘT playlist thoả thì chọn; nhiều playlist thoả thì không đoán.
  //  2. không playlist nào "chứa trọn": chấm điểm theo từ, từ hiếm trên kênh nặng hơn ("hướng dẫn" có ở mọi playlist
  //     nên gần như không tính); chỉ nhận khi đủ cao và bỏ xa playlist thứ hai.
  function closestPlaylist(name, list) {
    const toks = (s) => new Set(foldName(s).split(" ").filter(Boolean));
    const df = new Map();
    list.forEach((p) => toks(p.label).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const w = (t) => Math.log((list.length + 1) / ((df.get(t) || 0) + 0.5));
    const want = toks(name);
    const within = (a, b) => a.size >= 2 && [...a].every((t) => b.has(t));
    const scored = list
      .map((p) => {
        const have = toks(p.label);
        const all = new Set([...want, ...have]);
        let inter = 0, uni = 0;
        all.forEach((t) => { uni += w(t); if (want.has(t) && have.has(t)) inter += w(t); });
        return { ...p, score: uni ? inter / uni : 0, contained: within(have, want) || within(want, have) };
      })
      .sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);
    const contained = scored.filter((p) => p.contained);
    if (contained.length) return { pick: contained.length === 1 ? contained[0] : null, top: contained.length > 1 ? contained.slice(0, 3) : top };
    const [best, second] = scored;
    const ok = best && best.score >= 0.5 && best.score - (second?.score || 0) >= 0.15;
    return { pick: ok ? best : null, top };
  }

  function resolvePlaylist(want, list) {
    const id = playlistIdOf(want);
    if (id) {
      const p = list.find((x) => x.id === id || (x.id && (id.startsWith(x.id) || x.id.startsWith(id))));
      return p ? { p, how: "mã" } : { top: [] };
    }
    const exact = list.filter((x) => foldName(x.label) === foldName(want));
    if (exact.length === 1) return { p: exact[0], how: exact[0].label === want ? "tên" : "tên (khác hoa/thường, dấu)" };
    const { pick, top } = closestPlaylist(want, list);
    return pick ? { p: pick, how: `gần đúng ${pick.score.toFixed(2)}` } : { top };
  }

  // Tạo playlist mới ngay trong hộp chọn playlist (Studio 10/2026: nút ytcp-button.new-playlist-button → menu
  // tp-yt-paper-item[test-id=new_playlist] → ytcp-playlist-creation-dialog: #title-textarea #textbox, #create-button;
  // hiển thị mặc định Public). Chỉ gọi khi Excel ghi "+Tên" nên gõ sai chữ không đẻ ra playlist trùng.
  async function createPlaylist(name, dlg) {
    const creation = () => [...document.querySelectorAll("ytcp-playlist-creation-dialog")].find((d) => visible(d.querySelector("#create-button")));
    click(await waitFor(() => $("ytcp-button.new-playlist-button", dlg), { what: 'nút "New playlist"', timeout: 6000 }));
    click(await waitFor(() => $("tp-yt-paper-item[test-id=new_playlist]"), { what: 'mục "New playlist"', timeout: 6000 }));
    const host = await waitFor(creation, { what: "hộp tạo playlist", timeout: 8000 });
    await setEditableVerified(() => $("#title-textarea #textbox", host), name, "tên playlist mới");
    click(host.querySelector("#create-button"));
    await waitFor(() => !creation(), { what: "tạo playlist xong", timeout: 15000 });
    return waitFor(() => channelPlaylists(dlg).find((p) => p.label === name), { what: `playlist mới "${name}" trong danh sách`, timeout: 10000 });
  }

  async function addToPlaylists(names, ctx) {
    const scope = $("ytcp-uploads-dialog") || document;
    const box = await waitFor(() => $("ytcp-video-metadata-playlists", scope) || $("ytcp-video-metadata-playlists"), {
      what: 'ô "Playlists"',
      timeout: 10000,
    });
    if (!playlistDialog()) click(box.querySelector("ytcp-dropdown-trigger") || box);
    const dlg = await waitFor(playlistDialog, { what: "hộp chọn playlist", timeout: 8000 });
    const list = await waitFor(() => { const l = channelPlaylists(dlg); return l.length ? l : null; }, { what: "danh sách playlist", timeout: 8000 })
      .catch(() => []);
    const search = dlg.querySelector("input#search-input");
    const missing = [];
    ctx.result.playlists = ctx.result.playlists || [];
    for (const raw of names) {
      // "+Tên" = playlist mới: có rồi (trùng tên, kể cả lần chạy trước đã tạo) thì dùng, chưa có thì tạo.
      const isNew = raw.startsWith("+");
      const want = isNew ? norm(raw.slice(1)) : raw;
      let { p, how, top } = isNew
        ? (() => { const same = list.filter((x) => foldName(x.label) === foldName(want)); return same.length === 1 ? { p: same[0], how: "tên" } : {}; })()
        : resolvePlaylist(want, list);
      if (!p && isNew && want) {
        if (search) setInputValue(search, "");
        p = await createPlaylist(want, dlg);
        list.push(p);
        how = "tạo mới";
        ctx.log(`Đã tạo playlist mới "${p.label}"${p.id ? ` (${p.id})` : ""} — hiển thị Public`);
      }
      if (!p) {
        const goiY = top?.length ? ` — gần nhất: ${top.map((t) => `"${t.label}"`).join(", ")}` : "";
        missing.push(`"${want}"${goiY}`);
        continue;
      }
      // Đã tick sẵn (playlist vừa tạo được Studio tự tick, hoặc chạy lại) → khỏi tìm dòng.
      const ticked = () => p.id && (dlg.querySelector("tp-yt-iron-list")?.items || []).some((it) => it.id === p.id && it.checked);
      if (!ticked()) {
        // Danh sách là iron-list (chỉ vẽ dòng đang thấy) → lọc bằng ô tìm theo tên thật rồi chọn đúng dòng (ưu tiên theo mã).
        // Ô tìm có lúc chưa kịp nhận playlist vừa tạo → thử lại với ô tìm trống.
        const findRow = () =>
          [...dlg.querySelectorAll("#playlists-list li")].find(
            (li) =>
              visible(li) &&
              (p.id ? li.querySelector(`ytcp-checkbox-lit[test-id="${CSS.escape(p.id)}"]`) : norm((li.querySelector(".label-text") || li).textContent) === p.label)
          );
        let row = null;
        for (const q of search ? [p.label, ""] : [null]) {
          if (q != null) setInputValue(search, q);
          row = await waitFor(findRow, { what: `playlist "${p.label}"`, timeout: 5000 }).catch(() => null);
          if (row) break;
        }
        if (!row) {
          missing.push(`"${want}" (thấy "${p.label}" nhưng không bấm được dòng)`);
          continue;
        }
        const cb = row.querySelector("#checkbox[role=checkbox]") || row.querySelector("[role=checkbox]");
        if (!isChecked(cb)) {
          click(cb);
          await waitFor(() => isChecked(cb), { what: `tick playlist "${p.label}"`, timeout: 4000 });
        }
      }
      if (!ctx.result.playlists.includes(p.label)) ctx.result.playlists.push(p.label);
      ctx.log(p.label === want ? `Playlist: ${p.label}` : `Playlist: Excel ghi "${want}" → chọn "${p.label}"${p.id ? ` (${p.id})` : ""} theo ${how}. Cột Playlist sẽ ghi lại tên đúng.`);
    }
    if (search) setInputValue(search, "");
    const done = dlg.querySelector("ytcp-button.done-button") ||
      [...dlg.querySelectorAll("ytcp-button, button")].find((b) => visible(b) && /^(done|xong)$/i.test(norm(b.innerText)));
    if (done) click(done);
    await waitFor(() => !playlistDialog(), { what: "đóng hộp chọn playlist", timeout: 6000 });
    if (missing.length) throw new StepError(`Không thấy playlist trên kênh: ${missing.join("; ")} (tạo playlist, hoặc ghi tên đúng / mã PL… vào Excel)`);
  }

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
      id: "playlist",
      label: "Thêm vào playlist",
      optional: true,
      async run(ctx) {
        const names = [].concat(ctx.job.playlists || ctx.job.playlist || []).map(norm).filter(Boolean);
        if (!names.length) return;
        await addToPlaylists(names, ctx);
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
        const labelRe = /^(title and description language|ngôn ngữ (của )?tiêu đề và (phần )?mô tả)$/i;
        // Hộp upload bản mới (10/2026) có lúc không vẽ ô này: Studio tự lấy theo ngôn ngữ video
        // (đã kiểm: video bị kẹt ở bước này vẫn ra "Vietnamese" trên trang sửa). Không thấy ô thì bỏ qua.
        try {
          await waitFor(() => leafWithText(labelRe), { what: `ô "Title and description language"`, timeout: 6000 });
        } catch {
          return;
        }
        await selectDropdown(labelRe, toRegexList(ctx.job.titleLanguage), "Title and description language");
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
      label: "Chọn chế độ hiển thị / hẹn giờ",
      async run(ctx) {
        if (ctx.job.schedule) return scheduleAt(ctx.job.schedule);
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
        // Link nằm ở cột bên phải hộp upload; ở bước Visibility nó có thể bị che nên tìm cả phần tử ẩn.
        const dlg = document.querySelector("ytcp-uploads-dialog") || document;
        const link = $('a[href*="youtu.be/"]') || $('a[href*="youtube.com/shorts/"]') ||
          dlg.querySelector('a[href*="youtu.be/"], a[href*="youtube.com/shorts/"]');
        if (link) ctx.result.url = link.href;
        const done = await waitFor(() => $("#done-button"), { what: "nút Publish/Save" });
        click(done);
        // Sau khi bấm Publish, Studio hiện "Video published" (share dialog) — hoặc, nếu bản SD chưa xử lý xong,
        // hộp "Video processing … Close". Hộp này phải đóng thì mới mở được hộp upload video kế tiếp.
        const doneDialog = () =>
          [...document.querySelectorAll("ytcp-video-share-dialog, ytcp-uploads-still-processing-dialog, ytcp-dialog, tp-yt-paper-dialog")].find(
            (d) => visible(d) && /video published|video processing|đã xuất bản video|đang xử lý video/i.test(norm(d.innerText))
          );
        await waitFor(
          () => $("ytcp-video-share-dialog") || $("ytcp-prechecks-warning-dialog") || doneDialog() || !$("ytcp-uploads-dialog"),
          { what: "xác nhận đã đăng", timeout: 30000 }
        );
        const warn = $("ytcp-prechecks-warning-dialog");
        if (warn) {
          const ok = [...warn.querySelectorAll("ytcp-button, button")].find((b) => /publish|đăng/i.test(norm(b.innerText)));
          if (!ok) throw new StepError("Studio hiện cảnh báo trước khi đăng — cần người xem");
          click(ok);
          await sleep(2000);
        }
        ctx.published?.();
        // Hộp "Video published" hiện TRỄ vài giây sau khi hộp upload đóng: phải chờ nó hiện, bấm Close và chờ đóng hẳn,
        // nếu không hộp upload của video kế tiếp không mở được. Sau đó có thể còn hộp "Video processing" — đóng nốt.
        for (let n = 0; n < 3; n++) {
          const d = await waitFor(doneDialog, { what: 'hộp "Video published"', timeout: n ? 5000 : 30000 }).catch(() => null);
          if (!d) break;
          const shareLink = d.querySelector('a[href*="youtu.be/"], a[href*="youtube.com/shorts/"]');
          if (shareLink) {
            ctx.result.url = shareLink.href;
            ctx.published?.();
          }
          const close =
            [...d.querySelectorAll("ytcp-button, button")].find((b) => visible(b) && /^(close|đóng)$/i.test(norm(b.innerText))) ||
            $("#close-button", d);
          if (!close) throw new StepError('Không thấy nút Close trên hộp "Video published"');
          click(close);
          await waitFor(() => !visible(d) || !/video published|video processing|đã xuất bản video|đang xử lý video/i.test(norm(d.innerText)), {
            what: 'đóng hộp "Video published"',
            timeout: 10000,
          });
        }
        if (!ctx.result.url) throw new StepError("Đã bấm đăng nhưng không lấy được link video");
      },
    },
  ];

  // ---------- Hẹn giờ đăng (selector đã kiểm tra trên Studio: #second-container-expand-button,
  // #datepicker-trigger, ytcp-date-picker #textbox input, #time-of-day-container input) ----------
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function parseSchedule(s) {
    const m = String(s || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
    if (!m) throw new StepError(`Lịch đăng sai định dạng (cần YYYY-MM-DD HH:mm): ${s}`);
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  }
  const dateText = (t) => `${MONTHS[t.mo - 1]} ${t.d}, ${t.y}`; // giao diện Studio tiếng Anh
  const timeText = (t) => `${((t.h + 11) % 12) + 1}:${String(t.mi).padStart(2, "0")} ${t.h < 12 ? "AM" : "PM"}`;

  function setInputValue(input, value) {
    input.focus();
    input.select?.();
    document.execCommand("insertText", false, value);
    if (input.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  async function scheduleAt(when) {
    const t = parseSchedule(when);
    if (!$("#datepicker-trigger")) {
      const exp = $("#second-container-expand-button") || $("#second-container");
      if (!exp) throw new StepError('Không thấy mục "Schedule"');
      click(exp);
      await waitFor(() => $("#datepicker-trigger"), { what: "ô ngày hẹn giờ", timeout: 8000 });
    }

    const wantDate = dateText(t);
    if (norm($("#datepicker-trigger").innerText) !== wantDate) {
      click($("#datepicker-trigger"));
      const input = await waitFor(() => $("ytcp-date-picker tp-yt-paper-input#textbox input") || $("ytcp-date-picker input"), {
        what: "ô nhập ngày",
        timeout: 8000,
      });
      setInputValue(input, wantDate);
      // Đã kiểm tra trên Studio: Enter giả lập KHÔNG áp dụng ngày; gửi sự kiện submit của form#form thì ăn và tự đóng lịch.
      const form = input.closest("form");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      else pressEnter(input);
      await sleep(1200);
    }
    await waitFor(() => norm($("#datepicker-trigger")?.innerText) === wantDate, { what: `ngày hẹn ${wantDate}`, timeout: 6000 });

    const wantTime = timeText(t);
    const tin = await waitFor(() => $("#time-of-day-container input"), { what: "ô giờ hẹn" });
    if (norm(tin.value) !== wantTime) {
      setInputValue(tin, wantTime);
      pressEnter(tin);
      await sleep(800);
      const item = $all("tp-yt-paper-item").find((e) => norm(e.innerText) === wantTime);
      if (item) click(item);
      tin.blur();
      await sleep(800);
    }
    if (norm($("#time-of-day-container input")?.value) !== wantTime) {
      throw new StepError(`Giờ hẹn chưa ăn (đang là "${$("#time-of-day-container input")?.value}", cần "${wantTime}")`);
    }
  }

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
      scheduleExpand: !!($("#second-container-expand-button") || $("#datepicker-trigger")),
      doneButton: !!$("#done-button"),
    };
  }

  window.__ytu = { STEPS, StepError, snapshot, performAction, selfCheck, sleep, addToPlaylists };
})();
