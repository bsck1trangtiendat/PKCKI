/**
 * ═══════════════════════════════════════════════════════════════
 *  Cloudflare Worker — Proxy đặt lịch Phòng Khám BS.CKI TTĐ
 * ═══════════════════════════════════════════════════════════════
 *
 *  VẤN ĐỀ giải quyết:
 *    Bệnh nhân không có PAT → không ghi được lên GitHub trực tiếp.
 *    Worker này nhận booking từ bệnh nhân, dùng GITHUB_TOKEN (bí mật
 *    lưu trên Cloudflare) để đọc-gộp-ghi data.json lên GitHub.
 *
 *  HƯỚNG DẪN DEPLOY (5 phút, miễn phí):
 *  ──────────────────────────────────────
 *  1. Đăng ký / đăng nhập tại https://workers.cloudflare.com
 *  2. Tạo Worker mới → đặt tên (vd: pk-booking) → "Edit code"
 *  3. Xóa code mặc định → dán toàn bộ nội dung file này vào
 *  4. Sửa GH_OWNER / GH_REPO / GH_BRANCH / GH_FILE bên dưới cho đúng
 *  5. Nhấn "Save and Deploy"
 *  6. Vào Settings → Variables → thêm Secret:
 *       Tên:  GITHUB_TOKEN
 *       Giá trị: PAT GitHub của bạn (quyền Contents: Read & Write)
 *  7. Copy URL worker (vd: https://pk-booking.username.workers.dev)
 *  8. Dán URL đó vào ⚙️ Cài đặt → Cloudflare Worker URL trong admin panel
 *     HOẶC điền thẳng vào WORKER_URL trong index.html rồi upload lại
 *
 *  KẾT QUẢ:
 *    - Bệnh nhân đặt lịch → Worker ghi GitHub ✅
 *    - Admin mở trang → thấy lịch ngay ✅
 *    - PAT không bao giờ lộ ra trình duyệt bệnh nhân ✅
 */

// ── CẤU HÌNH REPO (sửa cho khớp với index.html) ───────────────
const GH_OWNER  = 'bsck1trangtiendat';  // GitHub username
const GH_REPO   = 'PKCKI';             // Tên repository
const GH_BRANCH = 'main';              // Branch
const GH_FILE   = 'data.json';         // File dữ liệu

// ── GIỚI HẠN INPUT (bảo vệ khỏi spam / injection) ─────────────
const MAX_NAME  = 120;   // ký tự
const MAX_PHONE = 25;
const MAX_NOTE  = 600;

// ── HELPERS ────────────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function corsHeaders(origin) {
  // Cho phép mọi origin (trang GitHub Pages của bạn có thể đổi URL)
  // Nếu muốn bảo mật hơn, đổi '*' thành domain GitHub Pages cụ thể
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

// ── GITHUB API ─────────────────────────────────────────────────

async function ghGetFile(token) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'PK-Booking-Worker/1.0',
    },
  });

  if (!res.ok) {
    const errText = await res.text();

    // File chưa tồn tại → trả về cấu trúc rỗng
    if (res.status === 404) {
      return { sha: null, content: { bookings: {}, updatedAt: null } };
    }

    if (res.status === 401) throw new Error('GITHUB_TOKEN không hợp lệ hoặc đã hết hạn. Cập nhật lại secret trên Cloudflare.');
    if (res.status === 403) throw new Error('GITHUB_TOKEN thiếu quyền. Tạo lại PAT với quyền Contents: Read & Write.');
    throw new Error(`GitHub API lỗi ${res.status}: ${errText}`);
  }

  const data = await res.json();
  // Decode base64 → UTF-8 (GitHub trả về base64)
  const raw = new TextDecoder().decode(
    Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0))
  );
  return { sha: data.sha, content: JSON.parse(raw) };
}

async function ghPutFile(token, content, sha, commitMsg) {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;

  // Encode UTF-8 → base64
  const jsonStr = JSON.stringify(content, null, 2);
  const encoded = btoa(
    new TextEncoder().encode(jsonStr).reduce((s, b) => s + String.fromCharCode(b), '')
  );

  const body = {
    message: commitMsg || `Đặt lịch mới ${new Date().toLocaleString('vi-VN')}`,
    content: encoded,
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'PK-Booking-Worker/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // SHA mismatch = conflict (người khác vừa commit) → caller sẽ retry
    if (res.status === 409 || (err.message && err.message.includes('SHA'))) {
      const conflict = new Error('SHA_CONFLICT');
      conflict.isConflict = true;
      throw conflict;
    }
    throw new Error(`GitHub write ${res.status}: ${err.message || 'unknown'}`);
  }
  return true;
}

// ── XỬ LÝ CHÍNH ────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // ── Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, msg: 'Chỉ hỗ trợ POST.' }, 405, origin);
    }

    // ── Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, msg: 'Body JSON không hợp lệ.' }, 400, origin);
    }

    // ── Ping / health check (từ nút "Kiểm tra Worker" trong admin panel)
    if (body._ping) {
      return jsonResponse({ ok: true, msg: '✅ Worker đang hoạt động!' }, 200, origin);
    }

    // ── Validate input
    const { date, time, name, phone, note } = body;

    if (!date || !time || !name || !phone) {
      return jsonResponse(
        { ok: false, msg: 'Thiếu thông tin bắt buộc (date, time, name, phone).' },
        400, origin
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse({ ok: false, msg: 'Định dạng ngày không hợp lệ (YYYY-MM-DD).' }, 400, origin);
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return jsonResponse({ ok: false, msg: 'Định dạng giờ không hợp lệ (HH:MM).' }, 400, origin);
    }
    // Không cho đặt ngày quá khứ
    const bookDate = new Date(date + 'T00:00:00');
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    today.setHours(0, 0, 0, 0);
    if (bookDate < today) {
      return jsonResponse({ ok: false, msg: 'Không thể đặt lịch cho ngày đã qua.' }, 400, origin);
    }

    // ── Token bí mật (Cloudflare secret)
    const token = env.GITHUB_TOKEN;
    if (!token) {
      return jsonResponse(
        { ok: false, msg: 'Worker chưa cấu hình GITHUB_TOKEN. Liên hệ quản trị viên.' },
        500, origin
      );
    }

    // ── Ghi lên GitHub với retry khi gặp SHA conflict
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Đọc dữ liệu hiện tại
        const { sha, content } = await ghGetFile(token);

        // Khởi tạo cấu trúc nếu cần
        if (!content.bookings)            content.bookings = {};
        if (!content.bookings[date])      content.bookings[date] = {};
        if (!content.bookings[date][time]) content.bookings[date][time] = [];

        // Kiểm tra slot đã được accept chưa
        const hasAccepted = content.bookings[date][time].some(b => b.status === 'accepted');
        if (hasAccepted) {
          return jsonResponse(
            { ok: false, msg: '⚠️ Khung giờ này đã có lịch được chấp nhận. Vui lòng chọn giờ khác.' },
            200, origin
          );
        }

        // Thêm booking mới
        content.bookings[date][time].push({
          id:     genId(),
          name:   String(name).trim().substring(0, MAX_NAME),
          phone:  String(phone).trim().substring(0, MAX_PHONE),
          note:   String(note || '').trim().substring(0, MAX_NOTE),
          at:     new Date().toISOString(),
          status: 'pending',
        });
        content.updatedAt = new Date().toISOString();

        // Ghi lên GitHub
        await ghPutFile(token, content, sha);

        return jsonResponse({ ok: true, msg: '✅ Đặt lịch thành công!' }, 200, origin);

      } catch (err) {
        if (err.isConflict && attempt < MAX_RETRIES) {
          // SHA conflict: đợi ngắn rồi retry để lấy SHA mới
          await new Promise(r => setTimeout(r, 300 * attempt));
          continue;
        }
        console.error(`Worker error (attempt ${attempt}):`, err.message);
        return jsonResponse(
          { ok: false, msg: `❌ Lỗi máy chủ: ${err.message}` },
          500, origin
        );
      }
    }

    // Hết retry
    return jsonResponse(
      { ok: false, msg: '❌ Có xung đột dữ liệu, vui lòng thử lại sau vài giây.' },
      500, origin
    );
  },
};
