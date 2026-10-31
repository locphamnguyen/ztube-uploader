// Đọc / ghi file Excel quản lý nội dung (tạo bằng tools/make_sheet.mjs) — dùng ExcelJS (lib/exceljs.min.js, biến toàn cục ExcelJS).
// Cột được nhận theo TÊN tiêu đề ở dòng 1 nên anh có thể đổi thứ tự / thêm cột riêng thoải mái.
const HEADERS = {
  status: ["trạng thái", "status"],
  file: ["file video", "file", "video"],
  thumbnail: ["thumbnail", "ảnh bìa"],
  title: ["tiêu đề", "title"],
  description: ["mô tả", "description"],
  tags: ["tags", "tag"],
  visibility: ["hiển thị", "visibility"],
  schedule: ["lịch đăng", "hẹn giờ", "schedule"],
  madeForKids: ["dành cho trẻ em", "made for kids"],
  alteredContent: ["có dùng ai", "nội dung ai", "altered content"],
  playlist: ["playlist", "playlists", "danh sách phát"],
  url: ["link youtube", "link", "url"],
  uploadedAt: ["ngày đăng", "uploaded at"],
  error: ["lỗi", "error"],
};

const SETTING_KEYS = {
  visibility: "hiển thị mặc định",
  madeForKids: "dành cho trẻ em",
  alteredContent: "có dùng ai",
  videoLanguage: "ngôn ngữ video",
  titleLanguage: "ngôn ngữ tiêu đề & mô tả",
  tags: "tags chung",
  footer: "chân mô tả",
  playlist: "playlist mặc định",
};

const STATUS_IN = {
  "đã đăng": "done", done: "done", "đã lên lịch": "scheduled", scheduled: "scheduled",
  "lỗi": "error", error: "error", "bỏ qua": "skip", skip: "skip",
};
const STATUS_OUT = { done: "Đã đăng", scheduled: "Đã lên lịch", error: "Lỗi", running: "Đang đăng", pending: "Chờ đăng", skip: "Bỏ qua" };

const pad2 = (n) => String(n).padStart(2, "0");

// Chuẩn hoá lịch đăng về "YYYY-MM-DD HH:mm". Nhận: 2026-10-08 19:30 · 08/10/2026 19:30 · ô ngày giờ của Excel.
export function normalizeSchedule(v) {
  if (v instanceof Date) {
    // Excel không có múi giờ; ExcelJS trả Date theo UTC = đúng giờ ghi trong ô.
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())} ${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}`;
  }
  const s = cellText(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} ${pad2(m[4])}:${m[5]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])} ${pad2(m[4])}:${m[5]}`;
  return s; // để validate() báo sai định dạng
}

export function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) {
    const hasTime = v.getUTCHours() || v.getUTCMinutes();
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}${hasTime ? ` ${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}` : ""}`;
  }
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return cellText(v.text);
    if ("result" in v) return cellText(v.result);
    if ("error" in v) return "";
    return "";
  }
  return String(v).replace(/\r\n?/g, "\n");
}

const norm = (s) => String(s || "").trim().toLowerCase();

function yesNo(v, dflt) {
  const s = norm(v);
  if (["có", "co", "yes", "true", "x", "1"].includes(s)) return true;
  if (["không", "khong", "no", "false", "0"].includes(s)) return false;
  return dflt;
}

function visibility(v, dflt) {
  const s = norm(v);
  if (["public", "công khai"].includes(s)) return "public";
  if (["unlisted", "không công khai"].includes(s)) return "unlisted";
  if (["private", "riêng tư"].includes(s)) return "private";
  return dflt;
}

const splitList = (v, re) => cellText(v).split(re).map((s) => s.trim()).filter(Boolean);

function headerMap(ws) {
  const cols = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = norm(cellText(cell.value));
    for (const [key, names] of Object.entries(HEADERS)) if (!cols[key] && names.includes(h)) cols[key] = col;
  });
  for (const need of ["file", "title"]) {
    if (!cols[need]) throw new Error(`Sheet "${ws.name}" thiếu cột "${HEADERS[need][0]}" ở dòng 1`);
  }
  return cols;
}

function readSettings(wb) {
  const ws = wb.getWorksheet("Cài đặt");
  const raw = {};
  if (ws) ws.eachRow((row, n) => { if (n > 1) raw[norm(cellText(row.getCell(1).value))] = cellText(row.getCell(2).value); });
  const get = (k) => raw[SETTING_KEYS[k]] ?? "";
  const langs = (k) => splitList(get(k), /;/);
  return {
    visibility: visibility(get("visibility"), "private"),
    madeForKids: yesNo(get("madeForKids"), false),
    alteredContent: yesNo(get("alteredContent"), true),
    videoLanguage: langs("videoLanguage").length ? langs("videoLanguage") : null,
    titleLanguage: langs("titleLanguage").length ? langs("titleLanguage") : null,
    tags: splitList(get("tags"), /[,\n]/),
    footer: get("footer").trim(),
    playlists: splitList(get("playlist"), /[;\n]/),
  };
}

async function loadWorkbook(fileHandle) {
  const buf = await (await fileHandle.getFile()).arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

const videosSheet = (wb) => wb.getWorksheet("Videos") || wb.worksheets[0];

// Trả về { jobs, settings }. Mỗi job giữ rowNumber để ghi kết quả về đúng dòng.
export async function readSheet(fileHandle) {
  const wb = await loadWorkbook(fileHandle);
  const ws = videosSheet(wb);
  const cols = headerMap(ws);
  const s = readSettings(wb);
  const jobs = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (k) => (cols[k] ? row.getCell(cols[k]).value : null);
    const file = cellText(get("file")).trim();
    if (!file) return;
    let description = cellText(get("description")).trim();
    if (s.footer && !description.includes(s.footer)) description = description ? `${description}\n\n${s.footer}` : s.footer;
    jobs.push({
      rowNumber: n,
      file,
      thumbnail: cellText(get("thumbnail")).trim() || null,
      title: cellText(get("title")).replace(/\n/g, " ").trim(),
      description,
      tags: [...new Set([...s.tags, ...splitList(get("tags"), /[,\n]/)])],
      visibility: visibility(cellText(get("visibility")), s.visibility),
      schedule: normalizeSchedule(get("schedule")),
      madeForKids: yesNo(cellText(get("madeForKids")), s.madeForKids),
      alteredContent: yesNo(cellText(get("alteredContent")), s.alteredContent),
      videoLanguage: s.videoLanguage,
      titleLanguage: s.titleLanguage,
      // Nhiều playlist cách nhau bằng ";" — để trống thì lấy "Playlist mặc định" ở sheet Cài đặt.
      playlists: splitList(get("playlist"), /[;\n]/).length ? splitList(get("playlist"), /[;\n]/) : s.playlists,
      status: STATUS_IN[norm(cellText(get("status")))] || "pending",
      url: cellText(get("url")).trim() || null,
      uploadedAt: cellText(get("uploadedAt")).trim() || null,
      error: cellText(get("error")).trim() || "",
    });
  });
  return { jobs, settings: s };
}

// Mở lại file (có thể anh vừa sửa trong Excel), chỉ ghi các cột kết quả của những dòng đã chạy.
export async function writeResults(fileHandle, jobs) {
  const wb = await loadWorkbook(fileHandle);
  const ws = videosSheet(wb);
  const cols = headerMap(ws);
  const rowOf = (job) => {
    const r = ws.getRow(job.rowNumber);
    if (cellText(r.getCell(cols.file).value).trim() === job.file) return r;
    let found = null; // dòng bị chèn/xoá trong lúc chạy → tìm lại theo tên file
    ws.eachRow((row, n) => { if (!found && n > 1 && cellText(row.getCell(cols.file).value).trim() === job.file) found = row; });
    return found;
  };
  // File cũ chưa có cột Playlist: thêm ở cuối dòng tiêu đề (giữ định dạng ô tiêu đề bên cạnh) để ghi tên playlist đã vào.
  if (!cols.playlist && jobs.some((j) => j.dirty && j.playlistsDone?.length)) {
    const head = ws.getRow(1);
    const last = head.cellCount;
    cols.playlist = last + 1;
    head.getCell(cols.playlist).value = "Playlist";
    head.getCell(cols.playlist).style = head.getCell(last).style;
    ws.getColumn(cols.playlist).width = 32;
    head.commit();
  }
  let written = 0;
  for (const job of jobs) {
    if (!job.dirty) continue;
    const row = rowOf(job);
    if (!row) continue;
    if (cols.status) row.getCell(cols.status).value = STATUS_OUT[job.status] || job.status;
    if (cols.url && job.url) row.getCell(cols.url).value = { text: job.url, hyperlink: job.url };
    if (cols.playlist && job.playlistsDone?.length) row.getCell(cols.playlist).value = job.playlistsDone.join("; ");
    if (cols.uploadedAt && job.uploadedAt) row.getCell(cols.uploadedAt).value = job.uploadedAt;
    if (cols.error) row.getCell(cols.error).value = job.error || null;
    row.commit();
    written++;
  }
  if (!written) return 0;
  // File đã mở/lưu bằng Excel có định dạng điều kiện kiểu x14: ExcelJS đọc mất công thức rồi
  // vỡ khi ghi (model.formulae undefined) — bỏ các luật đó, giữ phần dữ liệu.
  ws.conditionalFormattings = (ws.conditionalFormattings || [])
    .map((cf) => ({ ...cf, rules: (cf.rules || []).filter((r) => !/^(cellIs|expression)$/.test(r.type) || r.formulae?.length) }))
    .filter((cf) => cf.rules.length);
  const out = await wb.xlsx.writeBuffer();
  const w = await fileHandle.createWritable();
  await w.write(out);
  await w.close();
  return written;
}
