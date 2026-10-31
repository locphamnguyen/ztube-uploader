// Tạo / bổ sung file Excel quản lý nội dung đăng YouTube cho YT Studio Uploader.
//
//   bun make_sheet.mjs "<thư mục video>" [--match "Vonia*"] [--out noi-dung-youtube.xlsx] [--seed seed.json] [--no-scan]
//
// - Chưa có file: tạo mới 3 sheet "Videos", "Cài đặt", "Hướng dẫn".
// - Đã có file: GIỮ NGUYÊN mọi dòng/cột anh đã sửa, chỉ thêm video mới (so theo cột "File video").
// - --seed: file JSON [{file, thumbnail, title, description, tags, visibility, status, url, uploadedAt}] để điền sẵn nội dung (vd do AI soạn).
// - Quét *.mp4 trong thư mục (lọc thư mục con bằng --match), ghép <video>-thumbnail.jpg; bỏ bản -fb/-nhe nếu có bản gốc.
import ExcelJS from "exceljs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";

export const COLUMNS = [
  { key: "stt", header: "STT", width: 6 },
  { key: "status", header: "Trạng thái", width: 12 },
  { key: "file", header: "File video", width: 48 },
  { key: "thumbnail", header: "Thumbnail", width: 40 },
  { key: "title", header: "Tiêu đề", width: 60 },
  { key: "titleLen", header: "Số ký tự tiêu đề", width: 10 },
  { key: "description", header: "Mô tả", width: 80 },
  { key: "tags", header: "Tags", width: 40 },
  { key: "visibility", header: "Hiển thị", width: 12 },
  { key: "schedule", header: "Lịch đăng", width: 18 },
  { key: "madeForKids", header: "Dành cho trẻ em", width: 10 },
  { key: "alteredContent", header: "Có dùng AI", width: 10 },
  { key: "playlist", header: "Playlist", width: 32 },
  { key: "url", header: "Link YouTube", width: 32 },
  { key: "uploadedAt", header: "Ngày đăng", width: 18 },
  { key: "error", header: "Lỗi", width: 40 },
  { key: "note", header: "Ghi chú", width: 30 },
];
const STATUS = ["Chờ đăng", "Đang đăng", "Đã lên lịch", "Đã đăng", "Lỗi", "Bỏ qua"];
const VISIBILITY = ["public", "unlisted", "private"];
const YESNO = ["Có", "Không"];
const MAX_ROWS = 1000;
const LIGHT = ["-fb", "-nhe"];

const SETTINGS = [
  ["Hiển thị mặc định", "private", "public | unlisted | private — dùng khi cột Hiển thị để trống"],
  ["Dành cho trẻ em", "Không", "Có | Không"],
  ["Có dùng AI", "Có", "Khai báo nội dung tạo/biến đổi bằng AI (giọng AI, hình AI…)"],
  ["Ngôn ngữ video", "Vietnamese; Tiếng Việt", "Tên đúng như danh sách của Studio; nhiều tên cách nhau bằng ;"],
  ["Ngôn ngữ tiêu đề & mô tả", "Vietnamese; Tiếng Việt", "BẮT BUỘC: để English thì kênh bật dịch tự động sẽ ghi đè tiêu đề/mô tả"],
  ["Tags chung", "", "Thêm vào mọi video, cách nhau bằng dấu phẩy"],
  ["Chân mô tả", "", "Đoạn thêm vào CUỐI mọi mô tả (link GitHub, Zalo, hashtag chung…). Để trống = không thêm"],
  ["Playlist mặc định", "", "Tên playlist trên kênh (sai hoa/thường, dấu vẫn nhận; đổi tên thì chọn tên gần đúng nếu chắc chắn) hoặc mã PL…; \"+Tên\" = tạo mới nếu chưa có; nhiều playlist cách nhau bằng ; — cột Playlist ở sheet Videos được ưu tiên"],
];

const HELP = [
  "CÁCH DÙNG FILE NÀY VỚI EXTENSION YT STUDIO UPLOADER",
  "",
  "1. Mỗi dòng trong sheet Videos là một video. Đường dẫn 'File video' và 'Thumbnail' tính từ thư mục chứa file Excel này.",
  "2. Điền Tiêu đề (≤ 100 ký tự, không có < >), Mô tả (≤ 5000 ký tự, xuống dòng bằng Alt+Enter), Tags (cách nhau bằng dấu phẩy).",
  "3. Trạng thái: để 'Chờ đăng' (hoặc trống) = sẽ đăng; 'Đã đăng' / 'Đã lên lịch' / 'Bỏ qua' = extension bỏ qua; 'Lỗi' = chỉ chạy lại khi tick 'Chạy lại cả video lỗi'.",
  "4. Cột Hiển thị / Dành cho trẻ em / Có dùng AI để trống thì lấy theo sheet Cài đặt.",
  "   Playlist: ghi TÊN playlist ở cột 'Playlist' (nhiều playlist cách nhau bằng ;), để trống = lấy 'Playlist mặc định' ở sheet Cài đặt.",
  "     Tên sai hoa/thường, thiếu dấu hoặc tên cũ trước khi đổi vẫn nhận nếu chỉ khớp đúng một playlist; ghi mã PL… hay link '…list=PL…' cũng được.",
  "     Ghi '+Tên playlist' để TẠO MỚI khi kênh chưa có (hiển thị Public); kênh đã có tên đó thì dùng luôn, không tạo trùng.",
  "     Sau khi đăng, extension ghi lại TÊN playlist thật vào cột này.",
  "   Lịch đăng: ghi 'YYYY-MM-DD HH:mm' (vd 2026-10-08 19:30) hoặc 'dd/mm/yyyy HH:mm' để HẸN GIỜ đăng công khai; để trống = đăng ngay theo cột Hiển thị. Giờ theo múi giờ của trình duyệt (Việt Nam GMT+7).",
  "5. Extension tự điền Trạng thái, Link YouTube, Ngày đăng, Lỗi sau mỗi video. NÊN ĐÓNG FILE TRONG EXCEL khi đang chạy, nếu không extension không ghi được (kết quả vẫn giữ và ghi lại khi bấm 'Ghi kết quả vào Excel').",
  "6. Thêm video mới: chép file vào thư mục rồi chạy lại 'bun tools/make_sheet.mjs <thư mục>' — các dòng cũ được giữ nguyên.",
  "7. Có thể nhờ AI soạn tiêu đề/mô tả rồi dán vào đây, hoặc đưa vào file seed JSON (xem README).",
];

function parseArgs(argv) {
  const a = { root: null, match: "*", out: "noi-dung-youtube.xlsx", seed: null, scan: true };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--match") a.match = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--seed") a.seed = argv[++i];
    else if (v === "--no-scan") a.scan = false;
    else if (!a.root) a.root = v;
  }
  if (!a.root) {
    console.error('Dùng: bun make_sheet.mjs "<thư mục video>" [--match "Vonia*"] [--out noi-dung-youtube.xlsx] [--seed seed.json] [--no-scan]');
    process.exit(1);
  }
  return a;
}

const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
const posix = (p) => p.split(sep).join("/");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.mp4$/i.test(name) && !name.startsWith("._")) out.push(p);
  }
  return out;
}

function scanVideos(root, match) {
  const re = globToRe(match);
  const all = walk(root);
  const set = new Set(all);
  const found = [];
  for (const p of all.sort()) {
    const rel = posix(relative(root, p));
    const relDir = posix(relative(root, dirname(p))) || ".";
    if (!re.test(relDir)) continue;
    const stem = basename(p).replace(/\.mp4$/i, "");
    const light = LIGHT.find((s) => stem.endsWith(s));
    if (light && set.has(join(dirname(p), stem.slice(0, -light.length) + ".mp4"))) continue; // đã có bản gốc
    const base = light ? stem.slice(0, -light.length) : stem;
    const thumb = [".jpg", ".jpeg", ".png"].map((e) => join(dirname(p), `${base}-thumbnail${e}`)).find(existsSync);
    found.push({ file: rel, thumbnail: thumb ? posix(relative(root, thumb)) : "", title: relDir !== "." ? basename(dirname(p)) : base });
  }
  return found;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 30;
  row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC62828" } }));
}

function createWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "YT Studio Uploader";
  const ws = wb.addWorksheet("Videos", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ws.getRow(1));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  const col = (key) => ws.getColumn(COLUMNS.findIndex((c) => c.key === key) + 1).letter;
  const list = (vals) => ({ type: "list", allowBlank: true, formulae: [`"${vals.join(",")}"`], showErrorMessage: true, errorTitle: "Giá trị không hợp lệ", error: `Chọn một trong: ${vals.join(", ")}` });
  for (let r = 2; r <= MAX_ROWS; r++) {
    ws.getCell(`${col("status")}${r}`).dataValidation = list(STATUS);
    ws.getCell(`${col("visibility")}${r}`).dataValidation = list(VISIBILITY);
    ws.getCell(`${col("madeForKids")}${r}`).dataValidation = list(YESNO);
    ws.getCell(`${col("alteredContent")}${r}`).dataValidation = list(YESNO);
  }
  ws.addConditionalFormatting({
    ref: `${col("titleLen")}2:${col("titleLen")}${MAX_ROWS}`,
    rules: [{ type: "cellIs", operator: "greaterThan", formulae: [100], style: { font: { color: { argb: "FFC62828" }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFDECEA" } } } }],
  });
  const st = col("status");
  const rules = [
    ["Đã đăng", "FFE6F4EA"],
    ["Đã lên lịch", "FFE8F0FE"],
    ["Lỗi", "FFFDECEA"],
    ["Đang đăng", "FFFFF4E5"],
  ].map(([v, c]) => ({ type: "expression", formulae: [`$${st}2="${v}"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: c } } } }));
  ws.addConditionalFormatting({ ref: `A2:${ws.getColumn(COLUMNS.length).letter}${MAX_ROWS}`, rules });

  const cs = wb.addWorksheet("Cài đặt");
  cs.columns = [{ header: "Mục", key: "k", width: 28 }, { header: "Giá trị", key: "v", width: 60 }, { header: "Giải thích", key: "h", width: 70 }];
  styleHeader(cs.getRow(1));
  SETTINGS.forEach((s) => cs.addRow(s));
  cs.getCell("B2").dataValidation = list(VISIBILITY);
  cs.getCell("B3").dataValidation = list(YESNO);
  cs.getCell("B4").dataValidation = list(YESNO);
  cs.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const hs = wb.addWorksheet("Hướng dẫn");
  hs.getColumn(1).width = 140;
  HELP.forEach((line, i) => {
    const c = hs.getCell(`A${i + 1}`);
    c.value = line;
    c.alignment = { wrapText: true };
    if (i === 0) c.font = { bold: true, size: 14 };
  });
  return wb;
}

function addVideoRow(ws, v, r) {
  // Tìm cột theo TÊN tiêu đề ở dòng 1 (file cũ có thể thiếu cột / khác thứ tự, vd chưa có cột Playlist).
  const head = ws.getRow(1).values.map((x) => String(x || "").trim().toLowerCase());
  const idx = (key) => head.indexOf(COLUMNS.find((c) => c.key === key).header.toLowerCase());
  const row = ws.getRow(r);
  const set = (key, value) => { if (idx(key) > 0) row.getCell(idx(key)).value = value; };
  set("stt", { formula: "ROW()-1", result: r - 1 });
  set("status", v.status || "Chờ đăng");
  set("file", v.file);
  set("thumbnail", v.thumbnail || "");
  set("title", v.title || "");
  if (idx("title") > 0) set("titleLen", { formula: `LEN(${ws.getColumn(idx("title")).letter}${r})`, result: (v.title || "").length });
  set("description", v.description || "");
  set("tags", Array.isArray(v.tags) ? v.tags.join(", ") : v.tags || "");
  if (v.visibility) set("visibility", v.visibility);
  if (v.schedule) set("schedule", v.schedule);
  // Tên playlist (nhiều cái cách nhau bằng ;), "+Tên" = tạo mới nếu kênh chưa có.
  if (v.playlist || v.playlists) set("playlist", [].concat(v.playlists || v.playlist).join("; "));
  if (v.url) set("url", { text: v.url, hyperlink: v.url });
  if (v.uploadedAt) set("uploadedAt", v.uploadedAt);
  for (const k of ["description", "title"]) if (idx(k) > 0) row.getCell(idx(k)).alignment = { wrapText: true, vertical: "top" };
  row.alignment = { vertical: "top" };
  row.commit();
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = join(a.root, a.out);
  const isNew = !existsSync(out);
  let book;
  if (isNew) book = createWorkbook();
  else {
    book = new ExcelJS.Workbook();
    await book.xlsx.readFile(out);
  }
  const ws = book.getWorksheet("Videos");
  if (!ws) throw new Error(`${out} không có sheet "Videos"`);

  // File tạo từ bản cũ chưa có cột Playlist → thêm ở cuối, cùng kiểu ô tiêu đề.
  const head = ws.getRow(1);
  if (!head.values.some((v) => String(v || "").trim().toLowerCase() === "playlist")) {
    const last = head.cellCount;
    head.getCell(last + 1).value = "Playlist";
    head.getCell(last + 1).style = head.getCell(last).style;
    ws.getColumn(last + 1).width = 32;
    head.commit();
    console.log(`Thêm cột "Playlist" (cột ${ws.getColumn(last + 1).letter})`);
  }
  const header = ws.getRow(1).values.map((v) => String(v || "").trim().toLowerCase());
  const fileCol = header.indexOf("file video");
  const known = new Set();
  let lastRow = 1; // dòng cuối có "File video" (các ô dropdown làm rowCount lên tới 1000 nên không dùng rowCount)
  ws.eachRow((row, n) => {
    const f = String(row.getCell(fileCol).text || "").trim();
    if (n > 1 && f) {
      known.add(f);
      lastRow = n;
    }
  });

  const items = [];
  if (a.seed) items.push(...JSON.parse(readFileSync(a.seed, "utf8")));
  if (a.scan) items.push(...scanVideos(a.root, a.match));

  let added = 0;
  for (const v of items) {
    if (!v.file || known.has(v.file)) continue;
    known.add(v.file);
    addVideoRow(ws, v, ++lastRow);
    added++;
  }
  await book.xlsx.writeFile(out);
  console.log(`${out}: ${isNew ? "tạo mới, " : ""}thêm ${added} video, tổng ${lastRow - 1} video.`);
}

if (import.meta.main) await main();
