# YT Studio Uploader

Extension Chrome đăng video hàng loạt lên **YouTube Studio ngay trong trình duyệt bạn đang đăng nhập**, theo **file Excel quản lý nội dung** `noi-dung-youtube.xlsx` (hoặc `queue.json`): file video, thumbnail, tiêu đề, mô tả, tag, chế độ hiển thị…

- Chạy theo **kịch bản cố định**, giống các thao tác tay: mở hộp thoại Upload → chọn file → tiêu đề, mô tả → thumbnail → "không dành cho trẻ em" → Show more → khai báo có dùng AI → tag → **ngôn ngữ video + ngôn ngữ tiêu đề/mô tả** → Visibility → chờ upload → Publish → lấy link.
- **AI chỉ được gọi khi một bước lỗi hoặc kẹt**. Hỗ trợ **Claude, OpenAI, Qwen, Grok**: chọn một AI ưu tiên; AI đó lỗi (hết quota, sai key, mạng) thì tự chuyển sang AI khác đã có key. AI xem danh sách nút trên trang (và ảnh chụp nếu có), mỗi lần trả về **một** thao tác (bấm, gõ, cuộn, phím, chờ, làm lại bước, bỏ qua bước không bắt buộc, hoặc "cần người xử lý"). AI bị chặn các thao tác xoá hoặc huỷ video.
- **Không giới hạn dung lượng file**: extension đọc thẳng từ thư mục bạn cấp quyền rồi chuyển từng khúc sang tab Studio.
- Kết quả (Trạng thái, **Link YouTube**, Ngày đăng, Lỗi) được **ghi ngược vào đúng dòng trong file Excel**, giữ nguyên định dạng. Chạy lại sẽ bỏ qua video đã đăng.

## Vì sao là extension (không phải script hay API)

| Cách | Vấn đề |
|---|---|
| YouTube Data API | Project API chưa qua kiểm duyệt của Google thì video tải lên **bị khoá ở chế độ riêng tư**; quota khoảng 6 video/ngày |
| Playwright / Selenium | Không điều khiển được profile Chrome đang dùng; đăng nhập Google trong trình duyệt tự động hay bị chặn |
| **Extension** | Dùng luôn phiên đăng nhập hiện tại, chạy trong tab Studio thật. Nếu YouTube đổi giao diện thì AI gỡ giúp ở bước bị kẹt |

## Cài đặt

1. Mở `chrome://extensions` → bật **Developer mode** (góc phải trên).
2. Bấm **Load unpacked** → chọn thư mục `extension/` của repo này.
3. Ghim icon **YT Studio Uploader** lên thanh công cụ, bấm vào để mở trang điều khiển.

## Chuẩn bị file Excel `noi-dung-youtube.xlsx`

Đặt file Excel ở **thư mục gốc chứa video**. Đường dẫn trong file tính từ thư mục đó. Cần [bun](https://bun.sh) (build.sh/build.cmd của Vonia đã cài sẵn):

```bash
cd tools && bun install
# Tạo mới (hoặc bổ sung video mới vào file đã có — dòng cũ giữ nguyên):
bun make_sheet.mjs "E:/0project/vonia/omnivoice/video-output" --match "Vonia*"
# Điền sẵn nội dung do AI soạn (file JSON, xem bên dưới):
bun make_sheet.mjs "E:/0project/vonia/omnivoice/video-output" --seed noi-dung-ai.json --no-scan
```

File gồm 3 sheet. Mẫu trống: [examples/noi-dung-youtube.mau.xlsx](examples/noi-dung-youtube.mau.xlsx).

**Sheet "Videos"**: mỗi dòng là một video. Cột được nhận **theo tên tiêu đề**, nên đổi thứ tự hay thêm cột riêng vẫn được.

| Cột | Ý nghĩa |
|---|---|
| Trạng thái | `Chờ đăng` (hoặc trống) = sẽ đăng · `Đã đăng` / `Bỏ qua` = bỏ qua · `Lỗi` = chỉ chạy lại khi tick "Chạy lại cả video lỗi" |
| File video, Thumbnail | Đường dẫn tương đối, vd `Vonia - Hướng dẫn tab Hội thoại/Vonia-HuongDan-hoi-thoai-68s-16x9.mp4` |
| Tiêu đề | ≤ 100 ký tự, không có `<` `>`. Cột **Số ký tự tiêu đề** tự đếm, quá 100 thì tô đỏ |
| Mô tả | ≤ 5000 ký tự. Xuống dòng trong ô bằng **Alt+Enter** |
| Tags | Cách nhau bằng dấu phẩy |
| Hiển thị · Dành cho trẻ em · Có dùng AI | Chọn trong dropdown; để trống = lấy theo sheet Cài đặt |
| Link YouTube · Ngày đăng · Lỗi | **Extension tự điền** sau mỗi video |

**Sheet "Cài đặt"**: hiển thị mặc định, dành cho trẻ em, có dùng AI, **ngôn ngữ video**, **ngôn ngữ tiêu đề & mô tả** (bắt buộc, nếu không kênh bật dịch tự động sẽ ghi đè tiêu đề bằng tiếng Anh), tags chung, và **Chân mô tả**: đoạn tự thêm vào cuối mọi mô tả (link GitHub, Zalo, hashtag chung…).

> ⚠️ **Đóng file trong Excel khi extension đang chạy.** Excel khoá file đang mở nên extension không ghi được. Khi đó kết quả vẫn được giữ: đóng Excel rồi bấm **Ghi kết quả vào file**.

### Nhờ AI soạn nội dung

Cách 1: dán thẳng tiêu đề và mô tả AI soạn vào Excel.

Cách 2: nhờ AI trả về JSON rồi nạp bằng `--seed`. Mẫu prompt:

```text
Soạn nội dung đăng YouTube tiếng Việt cho các video sau (kèm kịch bản/lời thoại từng video).
Trả về DUY NHẤT một mảng JSON, mỗi phần tử:
{"file": "<đường dẫn video như tôi đưa>", "thumbnail": "<đường dẫn thumbnail>",
 "title": "<≤ 90 ký tự, không có < >, mở đầu bằng 'Hướng dẫn …' hoặc tên sản phẩm>",
 "description": "<câu mở đầu 'Đây là video …', 3–5 gạch đầu dòng ✅ nội dung chính, đoạn giới thiệu sản phẩm, 6–8 hashtag ở cuối; xuống dòng bằng 
>",
 "tags": ["8–12 từ khoá tìm kiếm"], "visibility": "public"}
```

### Vẫn dùng `queue.json` được

Thư mục không có file `.xlsx` thì extension đọc `queue.json` như bản cũ ([examples/queue.example.json](examples/queue.example.json), tạo bằng `python tools/make_queue.py`). Có nhiều nguồn thì chọn trong ô **Nguồn nội dung**.

Tên ngôn ngữ ghi đúng như trong danh sách của Studio. Giao diện Studio tiếng Anh dùng `Vietnamese`, tiếng Việt dùng `Tiếng Việt`. Ghi cả hai, cách nhau bằng dấu `;`.

## Chạy

1. Mở một tab **YouTube Studio** đã đăng nhập đúng kênh.
2. Bấm icon extension → **Chọn thư mục…** chứa video và file Excel (cấp quyền đọc/ghi). Extension tự chọn `noi-dung-youtube.xlsx` → kiểm tra bảng hàng đợi (dòng đỏ = dữ liệu chưa hợp lệ).
3. (Tuỳ chọn) điền API key của một hay nhiều AI trong Cài đặt, chọn **AI ưu tiên**, bấm **Thử kết nối AI** để kiểm tra key và model.
4. Bấm **Bắt đầu đăng**. Trang điều khiển tự tách ra cửa sổ riêng để tab Studio luôn hiển thị. Chrome hãm timer ở tab bị ẩn, nên tab Studio cần hiện thì tool mới chạy nhanh.
5. Theo dõi nhật ký. **Dừng sau video hiện tại** để dừng an toàn.

> Lần đầu nên thử 1 video với Hiển thị = `private` để xem kết quả, rồi mới chạy cả hàng đợi ở chế độ công khai.

**Kiểm tra selector trên tab Studio**: bấm trên trang upload hoặc trang sửa video để xem tool có tìm thấy đủ các ô không. Nút này không đăng gì.

## Nhà cung cấp AI

| AI | Model mặc định (sửa được) | Base URL mặc định |
|---|---|---|
| Claude (Anthropic) | `claude-sonnet-5-5` | `https://api.anthropic.com/v1` |
| OpenAI | `gpt-4.1` | `https://api.openai.com/v1` |
| Qwen (Alibaba DashScope) | `qwen-vl-max` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (tài khoản Trung Quốc đại lục: `https://dashscope.aliyuncs.com/compatible-mode/v1`) |
| Grok (xAI) | `grok-4` | `https://api.x.ai/v1` |

- OpenAI, Qwen, Grok dùng chung chuẩn OpenAI (chat completions + function calling). Muốn dùng cổng tương thích khác (OpenRouter, máy chủ nội bộ…) thì đổi Base URL của một dòng.
- Tool gửi kèm ảnh chụp tab Studio. Model không nhận ảnh (lỗi 400) thì tool tự gửi lại chỉ có văn bản. Nên chọn model có thị giác (vd `qwen-vl-max`) để AI nhìn được màn hình.
- Key chỉ gửi tới máy chủ của đúng nhà cung cấp đó.

## Khi bị kẹt

- **Có API key, bật AI**: tool gửi bước lỗi, thông báo lỗi và danh sách phần tử (kèm ảnh chụp nếu được) cho AI ưu tiên. AI làm tối đa N thao tác (mặc định 8), rồi tool làm lại đúng bước đó. Một video được nhờ AI tối đa 5 lần; quá số này thì đánh dấu `error` và chuyển sang video sau.
- **Không có AI**: bước không bắt buộc (thumbnail, khai báo AI) được bỏ qua; bước bắt buộc thì video bị đánh dấu `error` kèm tên bước.
- **Tab Studio tải lại giữa chừng**: tool dừng video đó và **không tự đăng lại** để tránh trùng. Vào mục Nội dung xem có bản nháp dở không.
- Kênh chưa xác minh số điện thoại thì không có ô thumbnail: tool bỏ qua và ghi log.

## Cấu trúc

```
extension/
  manifest.json      MV3, chỉ xin quyền studio.youtube.com + máy chủ API của 4 nhà cung cấp AI
  background.js      bấm icon → mở trang điều khiển
  uploader.html/js   trang điều khiển: thư mục, hàng đợi, chạy, ghi kết quả, gọi AI
  sheet.js           đọc/ghi file Excel (ExcelJS trong lib/), nhận cột theo tên
  lib/exceljs.min.js ExcelJS 4.4.0 (MIT) — đóng gói sẵn vì MV3 không cho tải code từ CDN
  content.js         cầu nối trang điều khiển ↔ tab Studio, nhận file theo từng khúc
  studio-steps.js    các bước tự động trên Studio (selector đã kiểm tra trên giao diện thật)
  ai.js              gọi Claude / OpenAI / Qwen / Grok (tool use) để lấy MỘT thao tác khi kẹt, tự chuyển AI khi lỗi
tools/make_sheet.mjs tạo / bổ sung file Excel nội dung (bun + ExcelJS)
tools/make_queue.py  tạo / bổ sung queue.json (cách cũ)
examples/            queue mẫu
```

## Giới hạn hiện tại

- Chưa hỗ trợ: lên lịch đăng (Schedule), playlist, end screen, cards, phụ đề. Có thể thêm bước mới vào `STEPS` trong `studio-steps.js`.
- Selector dựa trên giao diện YouTube Studio tháng 10/2026. Giao diện thay đổi thì AI sẽ gỡ; nếu lặp lại nhiều, cập nhật selector trong `studio-steps.js`.
