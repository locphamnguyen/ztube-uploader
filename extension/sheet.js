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
  madeForKids: ["dành cho trẻ em", "made for kids"],
  alteredContent: ["có dùng ai", "nội dung ai", "altered content"],
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
};

const STATUS_IN = { "đã đăng": "done", done: "done", "lỗi": "error", error: "error", "bỏ qua": "skip", skip: "skip" };
const STATUS_OUT = { done: "Đã đăng", error: "Lỗi", running: "Đang đăng", pending: "Chờ đăng", skip: "Bỏ qua" };

export function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
      madeForKids: yesNo(cellText(get("madeForKids")), s.madeForKids),
      alteredContent: yesNo(cellText(get("alteredContent")), s.alteredContent),
      videoLanguage: s.videoLanguage,
      titleLanguage: s.titleLanguage,
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
  let written = 0;
  for (const job of jobs) {
    if (!job.dirty) continue;
    const row = rowOf(job);
    if (!row) continue;
    if (cols.status) row.getCell(cols.status).value = STATUS_OUT[job.status] || job.status;
    if (cols.url && job.url) row.getCell(cols.url).value = { text: job.url, hyperlink: job.url };
    if (cols.uploadedAt && job.uploadedAt) row.getCell(cols.uploadedAt).value = job.uploadedAt;
    if (cols.error) row.getCell(cols.error).value = job.error || null;
    row.commit();
    written++;
  }
  if (!written) return 0;
  const out = await wb.xlsx.writeBuffer();
  const w = await fileHandle.createWritable();
  await w.write(out);
  await w.close();
  return written;
}
