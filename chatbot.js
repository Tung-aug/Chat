// =========================================================
//       CẤU HÌNH API / STATE
// =========================================================
// URL backend (Render)
const API_BASE = "https://nhom34-movie-threatre.onrender.com";

// API lấy danh sách phim dạng phân trang
const API_MOVIES_PAGE = `${API_BASE}/api/movies?page=0&size=200`;

// API tìm phim theo từ khóa
const API_MOVIES_SEARCH = (keyword) =>
  `${API_BASE}/api/movies/search?keyword=${encodeURIComponent(keyword)}`;

// API AI 
const API_AI_CHAT = `${API_BASE}/api/ai/chat`;

//Dữ liệu cache tối đa 60 giây rồi mới gọi lại API
const CACHE_TTL = 60 * 1000; 

//Trạng thái toàn cục (state) của chatbot,
const appState = {
  selectedMovie: null,      // phim người dùng đang chọn (để xem lịch chiếu)
  cinemasCache: null,       // cache danh sách rạp
  seatTypesCache: null,     // cache giá vé theo loại ghế
  pendingShowtimes: false,  //  đợi xác nhận xem lịch chiếu
  cinemasCacheAt: 0,        // thời điểm cache rạp được cập nhật
  seatTypesCacheAt: 0,      // thời điểm cache seat types được cập nhật
  moviesCache: null,        // cache phim
  moviesCacheAt: 0,         // thời điểm cache phim được cập nhật

};

/*
Hàm này là wrapper (hàm bao) cho fetch, giúp:
  luôn gọi dữ liệu mớ
  Kiểm tra lỗi HTTP
  Tự động parse (Phân tích và chuyển dữ liệu từ dạng thô sang dạng có cấu trúc để chương trình hiểu và sử dụng được) JSON
  Giảm lặp code trong toàn bộ chatbot
*/
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" }); 
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${url}`);
  return res.json();
}

//Lấy chi tiết phim 
async function fetchMovieDetailById(movieId) {
  const result = await fetchJson(`${API_BASE}/api/movies/${movieId}`);
  return (result?.success && result.data) ? result.data : null;
}

//Lấy danh sách rạp (cinemas) 
async function fetchCinemas(force = false) {
  const fresh = appState.cinemasCache && (Date.now() - appState.cinemasCacheAt < CACHE_TTL);
  if (!force && fresh) return appState.cinemasCache;

  const result = await fetchJson(`${API_BASE}/api/cinemas`);
  appState.cinemasCache = (result?.success && Array.isArray(result.data)) ? result.data : [];
  appState.cinemasCacheAt = Date.now();
  return appState.cinemasCache;
}

//Lấy danh sách loại ghế (seat types)
async function fetchSeatTypes(force = false) {
  const fresh = appState.seatTypesCache && (Date.now() - appState.seatTypesCacheAt < CACHE_TTL);
  if (!force && fresh) return appState.seatTypesCache;

  const result = await fetchJson(`${API_BASE}/api/seat-types`);
  appState.seatTypesCache = (result?.success && Array.isArray(result.data)) ? result.data : [];
  appState.seatTypesCacheAt = Date.now();
  return appState.seatTypesCache;
}

//Lấy danh sách phim
async function fetchMovies(force = false) {
  const fresh = appState.moviesCache && (Date.now() - appState.moviesCacheAt < CACHE_TTL);
  if (!force && fresh) return appState.moviesCache;

  const result = await fetchJson(API_MOVIES_PAGE);
  const movies = result?.data?.content;
  appState.moviesCache = Array.isArray(movies) ? movies : [];
  appState.moviesCacheAt = Date.now();
  return appState.moviesCache;
}

//Lấy lịch chiếu theo ngày/khung giờ
async function fetchShowtimesGrouped(movieId, cinemaId) {
  const url = `${API_BASE}/api/showtimes/grouped?movieId=${movieId}&cinemaId=${cinemaId}`;
  console.log("[SHOWTIMES] Request:", { movieId, cinemaId, url });

  const result = await fetchJson(url);
  console.log("[SHOWTIMES] Response:", result);

  return (result?.success && Array.isArray(result.data)) ? result.data : [];
}

// trả lời Có/Không khi bot đang chờ xác nhận xem lịch chiếu
//Hàm có
function isYes(text="") {
  const t = normalizeText(text);
  const YES = [
    "co", "ok", "oke", "okay", "yes", "y",
    "dong y", "duoc",
    "xem lich chieu", "xem suat chieu"
  ];
  return YES.some(k => {
    if (k.length <= 2) return new RegExp(`\\b${k}\\b`, "i").test(t);
    return t === k || t.includes(k);
  });
}

//Hàm Không
function isNo(text="") {
  const t = normalizeText(text);
  const NO = [
    "khong", "ko", "k", "no",
    "khong can", "thoi", "de sau", "huy", "cancel"
  ];
  return NO.some(k => {
    if (k.length <= 2) return new RegExp(`\\b${k}\\b`, "i").test(t);
    return t === k || t.includes(k);
  });
}

// =========================================================
// AI (Gemini) 
// =========================================================
// Gửi câu hỏi của người dùng lên backend AI và nhận phản hồi
async function callAiChat(userText) {
  const res = await fetch(API_AI_CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText })
  });

  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.success) throw new Error("AI response not success");
  return json?.data || { message: "", quickReplies: [] };
}

// AI nhận biết câu tư vấn/gợi ý (nên xem gì...)
function shouldAskAiFirst(text = "") {
  const t = normalizeText(text);

  // nhóm câu tư vấn / gợi ý
  const hasSuggest =
    t.includes("goi y") ||
    t.includes("de xuat") ||
    t.includes("tu van") ||
    t.includes("recommend") ||
    t.includes("nen xem") ||
    t.includes("nen di xem") ||
    t.includes("xem phim gi") ||
    t.includes("phim nao hay") ||
    t.includes("co phim nao hay");

  // nhóm thời điểm
  const hasWhen =
    t.includes("toi nay") ||
    t.includes("hom nay") ||
    t.includes("cuoi tuan") ||
    t.includes("bay gio");

  //nhóm thể loại phim 
  const hasGenre =
    t.includes("hanh dong") ||
    t.includes("kinh di") ||
    t.includes("hai") ||
    t.includes("tinh cam") ||
    t.includes("hoat hinh") ||
    t.includes("gia dinh") ||
    t.includes("vien tuong") ||
    t.includes("phieu luu") ||
    t.includes("tam ly") ||
    t.includes("hoat hinh") ||
    t.includes("anime");

  const isGenreOnly = hasGenre && t.split(" ").length <= 3 && !hasSuggest;

  if (isGenreOnly) return false;
  return hasSuggest || (t.includes("nen") && hasWhen) || (hasSuggest && hasGenre);
}

// Hiển thị kết quả trả về từ AI
function renderAiResult(aiData) {
  const msg = aiData?.message || "";
  if (msg) appendMessage(escapeHtml(msg), "bot");

  const qr = aiData?.quickReplies;
  if (Array.isArray(qr) && qr.length) {
    const buttons = qr.map(x => x?.label || x?.payload).filter(Boolean);
    if (buttons.length) scheduleQuickReplies(buttons, 50);
  } else {
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"], 50);
  }
}

//Định dạng giá tiền theo chuẩn Việt Nam
function formatPrice(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n.toLocaleString('vi-VN') + "đ";
  return String(v ?? "");
}

//Chuyển các ký tự đặc biệt thành dạng an toàn, HTML để tránh lỗi hiển thị
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Lấy ID của phim một cách an toàn
function getMovieId(movie) {
  return movie?.id ?? movie?.movieId ?? null;
}

// Lấy ngày hôm nay theo múi giờ Việt Nam để tránh lệch ngày
function getTodayYMD_VN() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

// Kiểm tra xem có tồn tại suất chiếu trong ngày hay không
function hasShowtimeOnDate(scheduleList, ymd) {
  if (!Array.isArray(scheduleList) || !ymd) return false;
  return scheduleList.some(d => String(d?.date || "").slice(0,10) === ymd && Array.isArray(d?.showTimes) && d.showTimes.length > 0);
}

// Kiểm tra 1 phim có suất chiếu hôm nay ở bất kỳ rạp nào không
async function movieHasShowtimesToday(movieId, cinemas, todayYMD, limitCinemas = 12) {
  const list = Array.isArray(cinemas) ? cinemas.slice(0, limitCinemas) : [];
  for (const c of list) {
    const schedule = await fetchShowtimesGrouped(movieId, c.id);
    if (hasShowtimeOnDate(schedule, todayYMD)) return true;
    
  }
  return false;
}

// Lọc phim: chỉ giữ phim có suất chiếu hôm nay
async function filterMoviesWithShowtimesToday(movies, cinemas, opts = {}) {
  const todayYMD = opts.todayYMD || getTodayYMD_VN();
  const limitMovies = opts.limitMovies ?? 80;        // giới hạn số phim cần check
  const limitCinemas = opts.limitCinemas ?? 12;      // mỗi phim scan tối đa N rạp
  const concurrency = opts.concurrency ?? 6;         // số phim check song song

  const arr = Array.isArray(movies) ? movies.slice(0, limitMovies) : [];
  const out = [];

  let idx = 0;
  async function worker() {
    while (idx < arr.length) {
      const i = idx++;
      const m = arr[i];
      const id = getMovieId(m);
      if (!id) continue;

      const ok = await movieHasShowtimesToday(id, cinemas, todayYMD, limitCinemas);
      if (ok) out.push(m);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const outIds = new Set(out.map(x => String(getMovieId(x))));
  return arr.filter(m => outIds.has(String(getMovieId(m))));
}

// Hiển thị trạng thái "Bot đang nhập..." và tạo hiệu ứng dấu chấm động
function startBotTyping(label = "Đang nhập trả lời") {
  const el = appendMessage(
    `<i>${escapeHtml(label)}<span class="typing-dots">...</span></i>`,
    "bot"
  );

  const dots = el.querySelector(".typing-dots");
  let i = 0;
  const timer = setInterval(() => {
    i = (i + 1) % 4;
    dots.textContent = ".".repeat(i);
  }, 320);

  // trả về hàm stop
  return () => {
    clearInterval(timer);
    el.remove();
  };
}

// =========================================================
// AI ORCHESTRATOR (Gemini): Một lớp điều phối thông minh dùng AI để hiểu câu người dùng và chọn hành động phù hợp  dữ liệu vẫn lấy từ API 
// =========================================================

// Trích xuất object JSON từ chuỗi text AI trả về
function extractJsonObject(text = "") {
  const s = String(text || "").trim();
  const m1 = s.match(/```json\s*([\s\S]*?)```/i);
  if (m1?.[1]) {
    try { return JSON.parse(m1[1].trim()); } catch(_) {}
  }

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const maybe = s.slice(start, end + 1);
    try { return JSON.parse(maybe); } catch(_) {}
  }

  return null;
}

// gọi Gemini -> trả về kế hoạch hoặc rỗng
async function callGeminiPlan(userText) {
  // lấy dữ liệu thật để AI gợi ý đúng 
  let moviesBrief = [];
  try {
    const movies = await fetchMovies(); 
    moviesBrief = (movies || []).slice(0, 30).map(m => ({
      title: m.title || "",
      genres: Array.isArray(m.genres) ? m.genres : [],
      releaseDate: m.releaseDate || ""
    }));
  } catch (_) {}

  const schemaHint = `
Bạn là "AI điều phối" cho Cinema Bot.
NHIỆM VỤ: CHỌN 1 action phù hợp, KHÔNG bịa dữ liệu.
Bạn chỉ được dùng dữ liệu thật do hệ thống cung cấp hoặc yêu cầu bot gọi API.

Các action hợp lệ:
- "NOW_SHOWING"        (xem danh sách phim đang chiếu)
- "CINEMAS"            (xem rạp / lọc rạp theo thành phố)
- "TICKET_PRICE"       (xem giá vé)
- "MOVIE_INFO"         (xem thông tin phim theo tên)
- "SHOWTIMES"          (xem lịch chiếu theo tên phim)
- "GENRE"              (gợi ý phim theo thể loại)
- "GENERAL"            (chat chung / hướng dẫn / câu hỏi ngoài dữ liệu)

Trả về DUY NHẤT 1 JSON (không thêm chữ ngoài JSON) theo mẫu:
{
  "action": "GENERAL|NOW_SHOWING|CINEMAS|TICKET_PRICE|MOVIE_INFO|SHOWTIMES|GENRE",
  "movieQuery": "",
  "city": "",
  "genre": "",
  "answer": ""
}

Quy tắc:
- Nếu action là NOW_SHOWING/CINEMAS/TICKET_PRICE: answer để "".
- Nếu action là MOVIE_INFO/SHOWTIMES: điền movieQuery ngắn gọn (tên phim).
- Nếu action là CINEMAS và user nhắc thành phố: điền city (ví dụ "Hà Nội").
- Nếu action là GENRE: điền genre (ví dụ "kinh dị", "hành động"...).
- Nếu action là GENERAL: trả lời ngắn gọn bằng tiếng Việt trong answer.

Dữ liệu phim thật (rút gọn) để tham khảo gợi ý (không bịa ngoài danh sách này):
${JSON.stringify(moviesBrief)}
`;

  const body = { userText: `${schemaHint}\n\nCâu hỏi người dùng: ${userText}` };

  const res = await fetch(API_AI_CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
  const result = await res.json();
  const aiText = result?.data?.message ?? "";

  const plan = extractJsonObject(aiText);
  return { plan, raw: aiText };
}

// thực thi hành động của AI (dữ liệu vẫn từ API thật)
async function runAiPlan(plan, originalText) {
  const action = (plan?.action || "").toUpperCase().trim();

  // fallback nếu AI không trả JSON chuẩn
  if (!action) {
    appendMessage(escapeHtml(plan?.answer || plan || "Mình chưa hiểu ý bạn."), "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return true;
  }

  if (action === "NOW_SHOWING") {
    await fetchMoviesFromJava();
    return true;
  }

  if (action === "TICKET_PRICE") {
    await showTicketPricesOnly();
    return true;
  }

  if (action === "CINEMAS") {
    const city = String(plan?.city || "").trim();
    if (city) {
      await showCinemasByCity(`rạp chiếu phim ${city}`);
      return true;
    }
    await showCinemasOnly();
    return true;
  }

  if (action === "MOVIE_INFO") {
    const q = String(plan?.movieQuery || "").trim() || originalText;
    // dùng luồng sẵn có: search -> show info -> hỏi có muốn xem lịch chiếu
    const moviesFound = await searchMovies(q);
    if (moviesFound.length === 1) {
      const id = getMovieId(moviesFound[0]);
      const full = id ? await fetchMovieDetailById(id) : null;
      appState.selectedMovie = full || moviesFound[0];
      appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
      appState.pendingShowtimes = true;
      askWantShowtimes();
      return true;
    }
    if (moviesFound.length > 1) {
      const top = moviesFound.slice(0, 10);
      let reply = `🔎 Mình thấy <b>${moviesFound.length}</b> phim khớp với "<b>${escapeHtml(q)}</b>":<br/><br/>`;
      top.forEach((m, i) => reply += `🎬 ${i + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
      reply += "<br/>👉 Bạn bấm chọn 1 phim:";
      appendMessage(reply, "bot");
      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      setTimeout(() => addMovieButtons(top), 50);
      return true;
    }
    appendMessage(`Mình không tìm thấy phim "<b>${escapeHtml(q)}</b>".`, "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return true;
  }

  if (action === "SHOWTIMES") {
    const q = String(plan?.movieQuery || "").trim() || originalText;
    await handleShowtimeIntentFromText(q);
    return true;
  }

  if (action === "GENRE") {
    const g = String(plan?.genre || "").trim();
    if (g) {
      await showMoviesByGenre(`thể loại ${g}`);
      return true;
    }
    await showMoviesByGenre(originalText);
    return true;
  }

  if (action === "GENERAL") {
    const ans = String(plan?.answer || "").trim() || "Mình có thể giúp bạn tra phim/rạp/giá vé/lịch chiếu.";
    appendMessage(escapeHtml(ans), "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return true;
  }

  appendMessage("Mình chưa hiểu yêu cầu. Bạn thử hỏi: “Phim đang chiếu hôm nay” nhé.", "bot");
  scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
  return true;
}


//Mở / đóng chatbot khi người dùng bấm vào nút toggle (bubble)
function toggleChatbot() {
  const bot = document.getElementById('chatbot');
  const toggle = document.querySelector('.chatbot-toggle'); 

  if (bot.classList.contains('show')) {
    // ĐÓNG chatbot
    bot.classList.remove('show');
    bot.classList.add('hidden');
    stopAutoRefresh();
    //toggle.classList.remove('hint-hidden');

    if (bot.classList.contains('fullscreen')) {
      bot.classList.remove('fullscreen');
      document.body.classList.remove('chatbot-fullscreen');
      document.getElementById('maximizeBtn').textContent = '⛶';
    }

  } else {
    // MỞ chatbot
    bot.classList.remove('hidden');
    bot.classList.add('show');

    startAutoRefresh();

    // Ẩn thông báo khi chatbot mở
    toggle.classList.add('hint-hidden');

    setTimeout(showInitialQuickReplies, 300);
  }
}

// Bật / tắt chế độ fullscreen cho chatbot
function toggleMaximize() {
  const bot = document.getElementById('chatbot');
  const btn = document.getElementById('maximizeBtn');
  const isFullscreen = bot.classList.toggle('fullscreen');
  btn.textContent = isFullscreen ? '❐' : '⛶';
  document.body.classList.toggle('chatbot-fullscreen', isFullscreen);
}

//Lắng nghe phím ESC trên toàn trang; dùng để thoát chế độ fullscreen của chatbot
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    const bot = document.getElementById('chatbot');
    const btn = document.getElementById('maximizeBtn');
    if (bot.classList.contains('fullscreen')) {
      bot.classList.remove('fullscreen');
      btn.textContent = '⛶';
      document.body.classList.remove('chatbot-fullscreen');
    }
  }
});

//Reset toàn bộ trạng thái chatbot về ban đầu
function resetChatbot() {
  const messages = document.getElementById('messages');
  messages.innerHTML = `
    <div class="message bot">
      Xin chào 👋<br/>
      Mình là <b>Cinema Bot</b> – trợ lý đặt vé xem phim.<br/>
      Bạn muốn xem phim gì hôm nay?
    </div>
  `;
  appState.selectedMovie = null;
  setTimeout(showInitialQuickReplies, 200);
  

  appState.cinemasCache = null;
  appState.cinemasCacheAt = 0;
  appState.seatTypesCache = null;
  appState.seatTypesCacheAt = 0;

  CITY_INDEX_READY = false;
  buildCityIndexFromCinemas();
  lastMoviesListShown = false;
  lastMoviesSignature = "";


}

//Tự động điều chỉnh chiều cao của textarea theo nội dung (auto-grow khi người dùng gõ nhiều dòng)
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/*
Xử lý sự kiện nhấn phím trong textarea nhập chat
- Enter: gửi tin nhắn
- Shift + Enter: xuống dòng
*/ 
function handleEnter(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

//Thêm một tin nhắn mới vào khung chat
function appendMessage(content, type) {
  const messages = document.getElementById('messages');
  const msg = document.createElement('div');
  msg.className = `message ${type}`;
  msg.innerHTML = content;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
  return msg;
}

//tránh lỗi giao diện khi hiển thị các nút gợi ý (tránh timeout cũ ghi đè)
let quickReplyTimer = null;

//Xóa toàn bộ các quick replies (nút gợi ý) đang hiển thị trong khung chat (dùng trước khi thêm quick replies mới)
function clearQuickReplies() {
  if (quickReplyTimer) {
    clearTimeout(quickReplyTimer);
    quickReplyTimer = null;
  }
  document.querySelectorAll('.quick-replies').forEach(q => q.remove());
}

// Xử lý hiển thị / ẩn hint (bong bóng gợi ý) của nút chatbot khi trang web vừa load xong
document.addEventListener('DOMContentLoaded', async() => {
  const toggle = document.querySelector('.chatbot-toggle');

  // Luôn hiện hint khi tải trang (F5 sẽ hiện lại)
  toggle.classList.remove('hint-hidden');

  await buildCityIndexFromCinemas();
});


//Lên lịch hiển thị quick replies sau một khoảng delay (tránh bị chồng nút khi chatbot trả lời liên tiếp)
function scheduleQuickReplies(buttons, delay = 50) {
  if (quickReplyTimer) clearTimeout(quickReplyTimer);
  quickReplyTimer = setTimeout(() => {
    clearQuickReplies();
    addQuickReplies(buttons);
  }, delay);
}

//Hiển thị bộ quick replies ban đầu khi chatbot vừa mở (giao diện chính để người dùng bắt đầu tương tác)
function showInitialQuickReplies() {
  clearQuickReplies();
  addQuickReplies([
    'Phim đang chiếu hôm nay',
    'Rạp chiếu phim',
    'Giá vé',
    'Hình thức thanh toán',
    'Đặt vé xem phim'
  ]);
}

//Tạo các nút gợi ý nhanh bên dưới khung chat để người dùng chọn mà không cần gõ lại
function addQuickReplies(buttons) {
  const messages = document.getElementById('messages');
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-replies';

  buttons.forEach(text => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.onclick = () => sendQuickMessage(text);
    wrapper.appendChild(btn);
  });

  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}


//Hiển thị danh sách phim dưới dạng các nút gợi ý (quick replies) để người dùng chọn nhanh mà không cần gõ lại tên phim
function addMovieButtons(movies) {
  clearQuickReplies();

  const messages = document.getElementById('messages');
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-replies';

  movies.forEach(movie => {
    const btn = document.createElement('button');
    btn.textContent = movie.title;
    btn.onclick = () => handlePickMovie(movie);
    wrapper.appendChild(btn);
  });

  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

//Hiển thị danh sách rạp dưới dạng các nút bấm (quick buttons)
function addCinemaButtons(cinemas, onPick) {
  clearQuickReplies();

  const messages = document.getElementById('messages');
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-replies';

  cinemas.forEach(cinema => {
    const btn = document.createElement('button');
    btn.textContent = cinema.cinemaName;
    btn.onclick = () => onPick(cinema);
    wrapper.appendChild(btn);
  });

  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

//Hàm này dùng để hỏi người dùng có muốn xem lịch chiếu hay không, chỉ được gọi sau khi người dùng đã chọn một bộ phim.
function askWantShowtimes() {
  if (!appState.selectedMovie) return;

  appendMessage(
    `👉 Bạn có muốn xem <b>lịch chiếu</b> cho phim <b>${escapeHtml(appState.selectedMovie.title)}</b> không?`,
    "bot"
  );

  // Nút lựa chọn
  if (quickReplyTimer) { clearTimeout(quickReplyTimer); quickReplyTimer = null; }
  clearQuickReplies();
  addQuickReplies([
    "Xem lịch chiếu",
    "Không cần"
  ]);
}

// =========================================================
// INTENT PATCH: Chuẩn hoá ký tự + từ khoá đồng nghĩa
// =========================================================

//  Bỏ dấu tiếng Việt 
function removeVietnameseTones(str = "") {
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D");
}
function looksLikeCinemaByCity(text="") {
  const t = normalizeText(text);
  return /\brap\b/.test(t) && !!extractCityKeyFromText(text);
}

// Chuẩn hoá câu người dùng nhập vào
function normalizeText(raw = "") {
  let s = String(raw).toLowerCase().trim();

  // từ viết tắt phổ biến
  s = s
    .replace(/\bbn\b/g, "bao nhieu")
    .replace(/\bko\b|\bk\b/g, "khong")
    .replace(/(^|\s)k(?=\s|$)/g, "$1khong") 
    .replace(/\bdc\b/g, "duoc")
    .replace(/\bvs\b/g, "voi")
    .replace(/\bmk\b/g, "minh");

  // bỏ dấu
  s = removeVietnameseTones(s);

  // bỏ ký tự đặc biệt (giữ chữ/số/khoảng trắng)
  s = s.replace(/[^a-z0-9\s:/-]/g, " ");

  // Gộp nhiều khoảng trắng
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

//Kiểm tra xem câu người dùng có chứa có 1 từ khóa nào đó không
function hasAnyKeyword(text, arr) {
  const t = normalizeText(text);
  return arr.some(k => t.includes(k));
}

// Chuẩn hoá cách người dùng ghi phần / part / tập / số La Mã trong tên phim
function normalizeSequelNumber(q = "") {
  let s = String(q || "").trim();
  if (!s) return s;

  s = s.replace(/\b(phan|part|tap|episode)\s*(\d+)\b/gi, "$2");

  s = s
    .replace(/\bii\b/gi, "2")
    .replace(/\biii\b/gi, "3")
    .replace(/\biv\b/gi, "4")
    .replace(/\bv\b/gi, "5")
    .replace(/\bvi\b/gi, "6");

  return s.trim();
}

// Hàm này trả về đúng/sai để quyết định: Tin nhắn này có nên coi là người dùng đang tra cứu một bộ phim cụ thể (để chạy searchMovies(...)) hay không?”
function shouldTreatAsMovieLookup(originalText, intentRes) {
  const t = normalizeText(originalText);
  if (!t) return false;

  const BLOCK = new Set([
    "TICKET_PRICE", "CINEMAS", "PAYMENT", "HOW_TO_BOOK",
    "HELP", "RESET", "NOW_SHOWING", "GENRE"
  ]);
  if (BLOCK.has(intentRes?.intent)) return false;

  if (intentRes?.intent === "MOVIE_INFO" || intentRes?.intent === "SHOWTIMES") return true;

  const lookupPatterns = [
    /^phim\s+/,
    /thong tin phim\s+/,
    /(lich chieu|gio chieu|suat chieu)\s+/
  ];
  if (lookupPatterns.some(re => re.test(t))) return true;

  const maybeLookup = hasAnyKeyword(originalText, ["xem ", "toi muon xem", "minh muon xem"]);
  const looksSuggest = hasAnyKeyword(originalText, ["goi y", "tu van", "nen xem", "recommend", "phim nao hay", "co phim nao hay"]);
  if (maybeLookup && !looksSuggest) return true;

  return false;
}


// Lấy tên phim để hiển thị (giữ nguyên dấu, chỉ bỏ từ dư thừa)
function extractMovieDisplay(originalText = "") {
  let s = String(originalText).trim();
  s = s
    .replace(/^(tôi|toi)\s+muốn\s+(xem\s+)?/i, "")
    .replace(/^(cho|cho tôi|cho toi)\s+(xem\s+)?/i, "")
    .replace(/\bphim\b/i, "")
    .trim();

  return s || originalText;
}


// Chuẩn hoá tên tỉnh/thành phố về một dạng khóa so sánh thống nhất
function canonicalCityKey(s = "") {
  let t = normalizeText(s); // bỏ dấu 
  // bỏ các tiền tố hành chính hay gặp: "tỉnh", "thành phố", "tp", "tp."
  t = t
    .replace(/\bthanh pho\b/g, "")
    .replace(/\btinh\b/g, "")
    .replace(/\btp\b/g, "")
    .replace(/\btp\.\b/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

//Kiểm tra nhanh xem câu người dùng có chứa từ khóa 1 intent cụ thể hay không
function hasIntent(text, intentKey) {
  const t = normalizeText(text);
  const keys = INTENT_KEYWORDS[intentKey] || [];
  return keys.some(k => t.includes(k));
}

//Trích xuất tên phim một cách thông minh từ câu người dùng
function extractMovieKeywordSmart(originalText = "") {
  let t = normalizeText(originalText);

  const removePhrases = [
    // thông tin
    "thong tin phim", "xem thong tin phim", "chi tiet phim", "noi dung phim", "gioi thieu phim",
    // lịch chiếu
    "lich chieu", "gio chieu", "suat chieu", "chieu luc", "phong chieu", "phong may",
    //các cụm “muốn biết”
    "toi muon biet", "cho toi biet", "ban cho toi biet", "cho minh biet", "muon biet", "biet"
  ];
  removePhrases.forEach(p => { t = t.replaceAll(p, " "); });

  t = t
    .replace(/\btoi muon\b/g, " ")
    .replace(/\bcho minh\b/g, " ")
    .replace(/\bminh muon\b/g, " ")
    .replace(/\bxin\b/g, " ")
    .replace(/\bxem\b/g, " ")
    .replace(/\bphim\b/g, " ");

  t = t.split(" va ")[0];

  t = t.replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t : null;
}


// =========================================================
// CITY PATCH: nhận biết thành phố + lọc rạp theo tỉnh/thành phố
// =========================================================

// hàm bóc ra tên thành phố/tỉnh mà người dùng đang nhắc tới
function extractCityCandidateLoose(originalText = "") {
  const t = normalizeText(originalText);

  // các pattern phổ biến user hay gõ
  const patterns = [
    /\brap(?:\s+chieu\s+phim|\s+phim)?\s+(.+)$/i, // "rạp chiếu phim ", "rạp phim "
    /\brap\s+(o|tai)\s+(.+)$/i,     // "rạp ở ..."
    /\btoi\s+o\s+(.+)$/i,          // "tôi ở ..."
    /\bminh\s+o\s+(.+)$/i,         // "mình ở ..."
    /\bdang\s+o\s+(.+)$/i,         // "đang ở ..."
    /\bo\s+(.+)$/i                 // "ở ..."
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (!m) continue;
    if (m[1]) return m[1].trim();      
    if (m[2]) return m[2].trim();      
  }


  // nếu user chỉ gõ 1-4 từ (ví dụ "Bắc Ninh", "Quảng Ngãi") thì cũng coi là candidate
  if (t.split(" ").length <= 4 && t.length >= 3) return t;
  //  loại các query chung về rạp
  if (t === "rap" || t === "rap chieu phim" || t === "danh sach rap") return null;
  return t;
}

// Lấy tên thành phố nguyên bản (giữ dấu) để hiển thị
function extractCityCandidateRaw(originalText = "") {
  const s = String(originalText).trim();

  const patterns = [
    /rạp(?:\s+chiếu\s+phim|\s+phim)?\s+(?:ở|tai|o)?\s*(.+)$/i, // "rạp phim Bắc Kạn", "rạp chiếu phim ở Bắc Kạn"
    /tôi\s+ở\s+(.+)$/i,
    /mình\s+ở\s+(.+)$/i,
    /đang\s+ở\s+(.+)$/i,
    /\bở\s+(.+)$/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m?.[1]) return m[1].trim();
  }

  return null;
}

//Chuyển từ cityKey (dạng chuẩn hoá, không dấu) sang tên hiển thị đẹp, có dấu, viết hoa đúng để hiển thị trong chat.
function cityLabelFromKeyOrCandidate(cityKey, candidate) {
  // Ưu tiên chữ chuẩn (có dấu) nếu có sẵn
  if (CITY_DISPLAY_NAMES[cityKey]) return CITY_DISPLAY_NAMES[cityKey];

  if (cityKey && CITY_INDEX.has(cityKey)) return CITY_INDEX.get(cityKey).display;

  return titleCaseVi(candidate || cityKey || "");
}

// Các từ phổ biến (không dấu) dạng chuẩn để so khớp tỉnh/thành phố
const CITY_ALIASES = {
  // HCM
  "hcm": "ho chi minh",
  "tphcm": "ho chi minh",
  "tp hcm": "ho chi minh",
  "tp. hcm": "ho chi minh",
  "sai gon": "ho chi minh",
  "saigon": "ho chi minh",
  "sg": "ho chi minh",
  "ho chi minh": "ho chi minh",

  // Hà Nội
  "hn": "ha noi",
  "hanoi": "ha noi",
  "ha noi": "ha noi",

  // Đà Nẵng
  "dn": "da nang",
  "danang": "da nang",
  "da nang": "da nang",

  // Cần Thơ
  "ct": "can tho",
  "can tho": "can tho"
  
};

// Tên thành phố để hiển thị (đúng dấu + in hoa)
const CITY_DISPLAY_NAMES = {
  "ho chi minh": "Hồ Chí Minh",
  "ha noi": "Hà Nội",
  "da nang": "Đà Nẵng",
  "can tho": "Cần Thơ"
};
//Tự động lấy danh sách tỉnh / thành phố từ CSDL rạp chiếu
let CITY_INDEX_READY = false;
// key (không dấu) -> { display: "Tên gốc trong CSDL", norm: "khong dau" }
const CITY_INDEX = new Map();

//chuẩn hoá chữ
function titleCaseVi(s = "") {
  return String(s)
    .trim()
    .split(/\s+/)
    .map(w => w ? (w[0].toUpperCase() + w.slice(1)) : "")
    .join(" ");
}

//danh sách rạp.
async function buildCityIndexFromCinemas() {
  try {
    const cinemas = await fetchCinemas(); // dùng cache sẵn
    CITY_INDEX.clear();

    cinemas.forEach(c => {
      const raw = (c?.provinceName || "").trim();
      if (!raw) return;

      const norm = normalizeText(raw); // đã bỏ dấu
      if (!norm) return;

      // Lưu bản hiển thị: ưu tiên dạng có trong CSDL
      if (!CITY_INDEX.has(norm)) {
        CITY_INDEX.set(norm, { display: raw, norm });
      }
    });

    CITY_INDEX_READY = true;
  } catch (e) {
    console.warn("buildCityIndexFromCinemas failed:", e);
    CITY_INDEX_READY = false;
  }
}

// GENRE: Thể loại gợi ý phim
const GENRE_ALIASES = {
  "hanh dong": ["hanh dong", "action"],
  "kinh di": ["kinh di", "horror"],
  "hai": ["hai", "comedy"],
  "tinh cam": ["tinh cam", "romance"],
  "hoat hinh": ["hoat hinh", "animation"],
  "tam ly": ["tam ly", "drama"],
  "khoa hoc vien tuong": ["khoa hoc vien tuong", "sci fi", "sci-fi", "science fiction"],
};

const GENRE_DISPLAY = {
  "hanh dong": "Hành động",
  "kinh di": "Kinh dị",
  "hai": "Hài",
  "tinh cam": "Tình cảm",
  "hoat hinh": "Hoạt hình",
  "tam ly": "Tâm lý",
  "khoa hoc vien tuong": "Khoa học viễn tưởng",
};

//Trích xuất từ khóa thể loại phim từ câu người dùng
function extractGenreKey(originalText="") {
  const t = normalizeText(originalText); // đã bỏ dấu
  for (const [key, aliases] of Object.entries(GENRE_ALIASES)) {
    for (const a of aliases) {
      const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(t)) return key;
    }
  }
  const m = t.match(/\bthe loai\s+([a-z0-9\s-]{2,})$/i);
  if (m?.[1]) return m[1].trim();
  return null;
}

//Lấy danh sách phim từ backend để phục vụ lọc theo thể loại
async function fetchMoviesForGenre(size = 80) {
  const url = `${API_BASE}/api/movies?page=0&size=${size}`;
  const result = await fetchJson(url);
  const movies = result?.data?.content;
  return Array.isArray(movies) ? movies : [];
}

//Kiểm tra một bộ phim có thuộc thể loại người dùng yêu cầu hay không
function movieHasGenre(movie, genreKey) {
  const genres = Array.isArray(movie.genres) ? movie.genres : [];
  const g = genres.map(x => normalizeText(x));
  const targetAliases = GENRE_ALIASES[genreKey]?.map(normalizeText);

  if (!targetAliases) {
    const k = normalizeText(genreKey);
    return g.some(x => x.includes(k));
  }
  return g.some(x => targetAliases.some(a => x.includes(a)));
}

//Hiển thị danh sách phim theo thể loại người dùng yêu cầu
async function showMoviesByGenre(originalText) {
  const genreKey = extractGenreKey(originalText);
  if (!genreKey) return false;

  const label = GENRE_DISPLAY[genreKey] || genreKey;
  const loading = appendMessage("<i>Đang gợi ý phim theo thể loại...</i>", "bot");

  try {
    const movies = await fetchMoviesForGenre(80);
    loading.remove();

    const filtered = movies.filter(m => movieHasGenre(m, genreKey));

    if (filtered.length === 0) {
      appendMessage(`Mình chưa thấy phim thuộc thể loại <b>${escapeHtml(label)}</b>.`, "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
      return true;
    }

    const top = filtered.slice(0, 12);
    let html = `🎭 <b>Gợi ý phim thể loại ${escapeHtml(label)}</b><br/><br/>`;
    top.forEach((m, i) => {
      html += `🎬 ${i + 1}. <b>${escapeHtml(m.title)}</b><br/>`;
    });
    html += `<br/>👉 Bấm vào tên phim để xem chi tiết:`;
    appendMessage(html, "bot");

    if (quickReplyTimer) clearTimeout(quickReplyTimer);
    setTimeout(() => addMovieButtons(top), 50);

    return true;
  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không thể gợi ý phim theo thể loại lúc này.";
    return true;
  }
}

// Trả về cityKey (không dấu) nếu thấy trong câu, ngược lại rỗng
function extractCityKeyFromText(originalText) {
  const t = normalizeText(originalText);
  if (!t) return null;

  for (const alias of Object.keys(CITY_ALIASES)) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(t)) return CITY_ALIASES[alias]; // trả về cityKey chuẩn (không dấu)
  }

  if (CITY_INDEX_READY && CITY_INDEX.size > 0) {
    for (const [cityKey] of CITY_INDEX.entries()) {
      const re = new RegExp(`\\b${cityKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(t)) return cityKey;
    }
  }

  return null;
}


//Kiểm tra xem câu người dùng có yêu cầu lọc danh sách rạp theo tỉnh / thành phố hay không
function shouldFilterCinemasByCity(originalText = "") {
  const t = normalizeText(originalText);

  const hasRap =
    t.includes("rap") ||
    t.includes("rap chieu") ||
    t.includes("rap chieu phim") ||
    t.includes("cinema") ||
    t.includes("cum rap");
  const cityKey = extractCityKeyFromText(originalText);
  const candidate = extractCityCandidateLoose(originalText); 
  const GENERIC = new Set([
    "rap", "rap chieu", "rap chieu phim", "danh sach rap",
    "cum rap", "he thong rap", "rap phim", "cinema"
  ]);
  if (GENERIC.has(t)) return false;

  if (hasRap && candidate && candidate.length >= 2) return true;

  // các câu kiểu “tôi ở …” vẫn cho lọc
  const locationPhrases = ["toi o", "minh o", "dang o", "song o", "toi dang o"];
  const mentionsLocation = locationPhrases.some(p => t.includes(p));
  if (cityKey) return true;

  // chỉ gõ mỗi địa danh (ít từ) cũng cho lọc (vd: "bac kan")
  const looksLikeJustCity = !!candidate && t === candidate;

  return mentionsLocation || looksLikeJustCity;
}




// Lọc rạp theo thành phố (provinceName)
async function showCinemasByCity(originalText) {
  if (!CITY_INDEX_READY) await buildCityIndexFromCinemas();

  const t = normalizeText(originalText);

  const GENERIC_CINEMA_QUERIES = new Set([
    "rap",
    "rap chieu",
    "rap chieu phim",
    "danh sach rap",
    "cum rap",
    "he thong rap",
    "rap phim",
    "cinema"
  ]);

  if (GENERIC_CINEMA_QUERIES.has(t)) return false;


  if (t === "rap chieu phim" || t === "danh sach rap" || t === "cum rap" || t === "he thong rap") {
    return false;
  }
  const hasRapKeyword =
    t.includes(" rap ") || t.startsWith("rap ") || t.includes("rap o") || t.includes("rap tai") ||
    t.includes("toi o") || t.includes("minh o") || t.includes("dang o");

  let cityKey = extractCityKeyFromText(originalText);

  // user gõ "rạp chiếu phim + <tỉnh/thành>"
  if (!cityKey) {
    const candidate = extractCityCandidateLoose(originalText); 
    if (candidate && CITY_INDEX_READY && CITY_INDEX.size > 0) {
      for (const [k] of CITY_INDEX.entries()) {
        if (candidate.includes(k) || k.includes(candidate)) {
          cityKey = k;
          break;
        }
      }
    }
  }


  //  Nếu không có từ khóa rạp và cũng không nhận ra cityKey hợp lệ -> không xử lý (trả false)
  if (!hasRapKeyword && !cityKey) return false;

  // Nếu user có ý hỏi rạp nhưng không nhận ra city
  if (hasRapKeyword && !cityKey) {
    const candidateNorm = extractCityCandidateLoose(originalText); // để nối (không dấu)
    const candidateRaw  = extractCityCandidateRaw(originalText);   // để hiển thị (có dấu)

    if (!candidateNorm && !candidateRaw) return false;

    //  Hiển thị ưu tiên bản có dấu user gõ
    const cityLabel = (candidateRaw && candidateRaw.length >= 2)
      ? candidateRaw
      : titleCaseVi(candidateNorm || "");

    appendMessage(
      `Xin lỗi bạn, hiện hệ thống <b>chưa có rạp</b> tại <b>${escapeHtml(cityLabel)}</b>.<br/>` +
      `Bạn có thể bấm <b>Rạp chiếu phim</b> để xem toàn bộ hệ thống rạp của chúng tôi.`,
      "bot"
    );

    scheduleQuickReplies(["Rạp chiếu phim", "Phim đang chiếu hôm nay", "Giá vé"]);
    return true;
  }

  const cityLabel = cityLabelFromKeyOrCandidate(cityKey, cityKey);

  const loading = appendMessage("<i>Đang lọc rạp theo thành phố...</i>", "bot");
  try {
    const cinemas = await fetchCinemas();
    loading.remove();

    const filtered = cinemas.filter(c => {
      const p = canonicalCityKey(c?.provinceName || "");
      const k = canonicalCityKey(cityKey || "");
      if (!p || !k) return false;
      return p === k || p.includes(k) || k.includes(p);
    });


    if (filtered.length === 0) {
      appendMessage(
        `Xin lỗi bạn, hiện hệ thống <b>chưa có rạp</b> tại <b>${escapeHtml(cityLabel)}</b>.`,
        "bot"
      );
      scheduleQuickReplies(["Rạp chiếu phim", "Phim đang chiếu hôm nay", "Giá vé"]);
      return true;
    }

    let html = `<b>Rạp ở ${escapeHtml(cityLabel)}</b><br/><br/>`;
    filtered.slice(0, 15).forEach((c, i) => {
      html += `• ${i + 1}. <b>${escapeHtml(c.cinemaName)}</b>` +
              (c.provinceName ? ` (${escapeHtml(c.provinceName)})` : "") +
              `<br/>`;
    });
    if (filtered.length > 15) html += `… và ${filtered.length - 15} rạp khác<br/>`;

    appendMessage(html, "bot");

    if (appState.selectedMovie) {
      appendMessage(
        `Bạn đang chọn phim <b>${escapeHtml(appState.selectedMovie.title)}</b>. Bấm rạp bên dưới để xem lịch chiếu:`,
        "bot"
      );
      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      const movieSnapshot = appState.selectedMovie; // + snapshot phim
      setTimeout(() => {
        addCinemaButtons(filtered.slice(0, 15), async (cinema) => {
          await showShowtimesForCinema(cinema, movieSnapshot);
        });
      }, 50);

    } else {
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Giá vé", "Làm sao để đặt vé?"]);
    }

    return true;

  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không lọc được rạp theo thành phố.";
    return true;
  }
}

//  Bộ từ khoá + đồng nghĩa cho intent (ý định)
const INTENT_KEYWORDS = {
  GREETING: ["xin chao", "chao", "hello", "hi", "hey", "alo"],
  RESET: ["reset", "lam moi", "khoi dong lai", "bat dau lai", "xoa chat"],
  HELP: ["giup", "tro giup", "huong dan", "help", "ban lam duoc gi", "ban biet gi"],

  HOW_TO_BOOK: [
    "dat ve", "mua ve", "cach dat ve", "lam sao dat ve", "huong dan dat ve",
    "book ve", "booking", "dat ve xem phim"
  ],
  PAYMENT: [
    "thanh toan", "tra tien", "hinh thuc thanh toan", "payment",
    "momo", "zalopay", "vnpay", "visa", "master", "the"
  ],
  TICKET_PRICE: [
    "gia ve", "ve bao nhieu", "bao nhieu tien", "gia bao nhieu",
    "phi ve", "tien ve", "bang gia", "gia ghe", "gia loai ghe"
  ],
  CINEMAS: [
    "rap", "rap chieu", "rap chieu phim", "danh sach rap",
    "cinema", "cum rap", "he thong rap", "rap phim"
  ],
  NOW_SHOWING: [
    "phim dang chieu",
    "dang chieu",
    "now showing",
    "danh sach phim",
    "phim moi"
  ],

  TODAY_SHOWING: [
    "phim hom nay",
    "hom nay co phim gi",
    "hom nay chieu phim gi",
    "hom nay chieu nhung phim nao",
    "hom nay co nhung phim nao",
    "hom nay co phim nao",
    "bay gio chieu phim gi",
    "phim chieu hom nay",
    "phim hom nay chieu",
    "hom nay phim chieu",
    "phim chieu gi hom nay",
    "hom nay co phim chieu nao"
  ],

  SHOWTIMES: [
    "lich chieu", "suat chieu", "gio chieu", "chieu luc", "chieu gio",
    "phong chieu", "phong may", "room", "showtime"
  ],
  CITY_CINEMAS: [
    "rap o", "rap tai", "rap khu vuc", "rap gan", "rap o dau",
    "rap ho chi minh", "rap ha noi", "rap da nang", "rap can tho",
    "cinema in", "rap in"
  ],

  GENRE: [
    "the loai", "phim the loai", "phim hanh dong", "phim kinh di", "phim tinh cam",
    "phim hai", "phim hoat hinh", "phim tam ly", "phim khoa hoc vien tuong",
    "action", "horror", "comedy", "romance", "animation", "sci fi"
  ],
    MOVIE_INFO: [
    "thong tin phim", "xem thong tin phim", "chi tiet phim", "noi dung phim",
    "gioi thieu phim", "phim noi dung gi", "film info", "movie info"
  ],


};

// Kiểm tra xem text t có chứa keyword k không
function includesKeywordSafe(t, k) {
  // keyword quá ngắn => bắt theo nguyên từ để tránh dính "phim" -> "hi"
  if (k.length <= 2) {
    const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(t);
  }
  return t.includes(k);
}

//  Phát hiện intent (ý định) của người dùng dựa trên từ khóa (cụm dài ưu tiên hơn)
function detectIntent(userText) {
  const t = normalizeText(userText);
  if (!t) return { intent: null, score: 0, normalized: t, hit: null };
  let best = { intent: null, score: 0, normalized: t, hit: null };

  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    for (const k of keys) {
      if (includesKeywordSafe(t, k)) {
        const score = Math.min(10, 2 + Math.floor(k.length / 4));
        if (score > best.score) best = { intent, score, normalized: t, hit: k };
      }
    }
  }
  return best;
}
//Trả về true khi câu người dùng mơ hồ / khó đoán / nhiều ý nghĩa
//Trả về false khi rule-based của chatbot đã đủ xử lý tốt
function shouldUseGeminiOrchestrator(intentRes, originalText) {
  const t = normalizeText(originalText);
  if (!t) return false;

  // Không gọi AI khi câu quá ngắn
  if (t.length < 4) return false;

  // Nếu intent rõ rồi thì khỏi (score cao)
  if ((intentRes?.score || 0) >= 6) return false;

  // Nếu đang FAQ đơn giản thì để rule-based
  if (isFaqQuery(originalText)) return false;

  // Nếu user đang hỏi rạp theo thành phố thì để flow rạp xử lý trước
  if (looksLikeCinemaByCity(originalText) || shouldFilterCinemasByCity(originalText)) return false;

  // Còn lại: mơ hồ/đa nghĩa => để Gemini điều phối
  return true;
}



//  Tách “tên phim” khỏi câu (để searchMovies dễ nối hơn)
function extractMovieQuery(originalText) {
  const t = normalizeText(originalText);

  const patterns = [
    /^lich chieu (phim )?/,
    /^gio chieu (phim )?/,
    /^suat chieu (phim )?/,
    /^dat ve (phim )?/,
    /^mua ve (phim )?/,
    /^phong chieu (phim )?/,
    /^cho minh (xem )?/,
    /^toi muon (xem )?/,
  ];

  let q = t;
  patterns.forEach(p => { q = q.replace(p, ""); });
  q = q.trim();

  if (q.length < 2) return null;
  return q;
}

//  Kiểm tra xem câu người dùng có phải là: "đặt vé + kèm tên phim" hay không
function looksLikeBookWithMovie(originalText) {
  const t = normalizeText(originalText);
  const hasBook = t.includes("dat ve") || t.includes("mua ve") || t.includes("booking") || t.includes("book ve");
  if (!hasBook) return false;

  const q = extractMovieQuery(originalText);
  // nếu sau khi bỏ “đặt vé...” còn lại khá dài => có thể là tên phim
  return !!q && q.length >= 3;
}


// FUZZY MATCH (Levenshtein) - Tính Levenshtein Distance (khoảng cách chỉnh sửa) tính số bước chỉnh sửa ít nhất để biến chuỗi a thành chuỗi b
function levenshtein(a = "", b = "") {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

// Tính độ tương đồng giữa 2 chuỗi dựa trên Levenshtein 
function similarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

// Tìm kiếm phim theo kiểu fuzzy search (so khớp gần đúng)
async function fuzzySearchMovies(keyword, threshold = 0.6) {
  const normQ = normalizeText(keyword);
  if (normQ.length < 3) return [];

  //dùng cache để tránh gọi mạng liên tục
  const moviesAll = await fetchMovies(false);
  if (!Array.isArray(moviesAll) || moviesAll.length === 0) return [];
  // giới hạn để tránh lag (Levenshtein khá nặng)
  const movies = moviesAll.slice(0, 120);

  const scored = movies.map(m => {
    const titleNorm = normalizeText(m.title || "");
    return {
      movie: m,
      score: similarity(normQ, titleNorm)
    };
  });

  return scored
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(x => x.movie);
}

// Xử lý câu hỏi người dùng và trả về phản hồi của chatbot
function getBotReply(text) {
  const t = normalizeText(text); // ✅ không dấu

  // Đặt vé
  if (
    t.includes("dat ve") ||
    t.includes("mua ve") ||
    t.includes("cach dat ve") ||
    t.includes("lam sao dat ve") ||
    t.includes("booking") ||
    t.includes("book ve")
  ) {
    scheduleQuickReplies([
      "Phim đang chiếu hôm nay",
      "Rạp chiếu phim",
      "Giá vé",
      "Hình thức thanh toán"
    ]);

    return `
      🎟 <b>Cách đặt vé xem phim</b><br/>
      1️⃣ Chọn phim bạn muốn xem<br/>
      2️⃣ Chọn đặt vé<br/>
      3️⃣ Chọn suất chiếu, ghế ngồi và rạp phù hợp yêu cầu của bạn<br/>
      4️⃣ Thanh toán và nhận vé điện tử 📱
    `;
  }

  // Thanh toán
  if (
    t.includes("thanh toan") ||
    t.includes("tra tien") ||
    t.includes("hinh thuc thanh toan") ||
    t.includes("payment")
  ) {
    scheduleQuickReplies([
      "Phim đang chiếu hôm nay",
      "Làm sao để đặt vé?",
      "Giá vé",
      "Rạp chiếu phim"
    ]);

    return `
      <b>Các hình thức thanh toán</b><br/>
      Ví điện tử  VNPay<br/>
      Thanh toán tại rạp
    `;
  }

  scheduleQuickReplies([
    "Phim đang chiếu hôm nay",
    "Rạp chiếu phim",
    "Giá vé",
    "Làm sao để đặt vé?",
    "Hình thức thanh toán"
  ]);
  return `Xin lỗi bạn, mình chưa hiểu ý bạn. Mình có thể giúp gì cho bạn?`;
}

// Kiểm tra câu hỏi người dùng có thuộc nhóm FAQ (hỏi đáp chung) hay không
function isFaqQuery(text) {
  const t = normalizeText(text);
  return (
    t.includes("dat ve") ||
    t.includes("mua ve") ||
    t.includes("cach dat ve") ||
    t.includes("lam sao dat ve") ||
    t.includes("booking") ||
    t.includes("book ve") ||
    t.includes("thanh toan") ||
    t.includes("tra tien") ||
    t.includes("hinh thuc thanh toan") ||
    t.includes("payment")
  );
}

// =========================================================
//  MOVIE: SEARCH + HIỂN THỊ CHI TIẾT
// =========================================================

// Tìm kiếm phim theo từ khóa
async function searchMovies(keyword) {
  const raw = String(keyword || "").trim();
  if (!raw) return [];

  // 1) thử raw (giữ nguyên ký tự/dấu)
  let res = await fetch(API_MOVIES_SEARCH(raw));
  if (res.ok) {
    const result = await res.json();
    if (result?.success && Array.isArray(result.data) && result.data.length) return result.data;
  }

  // 2) fallback: thử bản bỏ dấu (nếu khác)
  const norm = removeVietnameseTones(raw);
  if (norm !== raw) {
    res = await fetch(API_MOVIES_SEARCH(norm));
    if (!res.ok) throw new Error("Server Java không phản hồi (search)");
    const result2 = await res.json();
    return (result2?.success && Array.isArray(result2.data)) ? result2.data : [];
  }

  if (!res.ok) throw new Error("Server Java không phản hồi (search)");
  return [];
}


// Thông tin chi tiết phim để hiển thị trong chatbot
function formatMovieDetail(movie) {
  const title = escapeHtml(movie.title ?? "Không rõ tên");
  const desc = escapeHtml(movie.describe ?? movie.description ?? "Thông tin đang cập nhật");
  const runtime = movie.runtimeMin ? `${movie.runtimeMin} phút` : "Đang cập nhật";
  const release = movie.releaseDate ? escapeHtml(movie.releaseDate) : "Đang cập nhật";
  const language = escapeHtml(movie.language ?? "Đang cập nhật");
  const director = escapeHtml(movie.director ?? "Đang cập nhật");

  const genres = Array.isArray(movie.genres) ? movie.genres.map(escapeHtml).join(", ") : "";
  const casts = Array.isArray(movie.casts) ? movie.casts.map(escapeHtml).join(", ") : "";

  const coverImg = movie.coverImg ? escapeHtml(movie.coverImg) : "";
  const profileImg = movie.profileImg ? escapeHtml(movie.profileImg) : "";

  return `
    <div style="display:flex; gap:12px; align-items:flex-start;">
      ${(profileImg || coverImg) ? `
        <img src="${profileImg || coverImg}" alt="${title}"
            style="width:72px;height:96px;object-fit:cover;border-radius:10px;border:1px solid rgba(255,255,255,0.12);" />
      ` : ""}

      <div style="flex:1;">
        🎬 <b>${title}</b><br/>
        🗓 <b>Khởi chiếu:</b> ${release}<br/>
        ⏱ <b>Thời lượng:</b> ${runtime}<br/>
        🌐 <b>Ngôn ngữ:</b> ${language}<br/>
        🎥 <b>Đạo diễn:</b> ${director}<br/>
        ${genres ? `🏷 <b>Thể loại:</b> ${genres}<br/>` : ""}
        ${casts ? `⭐ <b>Diễn viên:</b> ${casts}<br/>` : ""}
      </div>
    </div>

    <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08);">
      📝 ${desc}
    </div>
  `;
}

//Thêm hàm chọn phim
async function handlePickMovie(movieLite) {
  const loading = appendMessage("<i>Đang tải thông tin phim...</i>", "bot");

  try {
    const id = getMovieId(movieLite);
    if (!id) {
      loading.remove();
      appendMessage("Mình không lấy được mã phim. Bạn thử chọn lại phim nhé.", "bot");
      return;
    }

    const full = await fetchMovieDetailById(id);
    loading.remove();

    appState.selectedMovie = full || movieLite; // full ưu tiên
    appendMessage(formatMovieDetail(appState.selectedMovie), "bot");

    // hỏi xem lịch chiếu (flow bạn muốn)
    appState.pendingShowtimes = true;
    askWantShowtimes();

  } catch (e) {
    console.error(e);
    loading.remove();
    appendMessage("Không tải được thông tin phim lúc này.", "bot");
  }
}


//Tách tên phim theo intent (Không phụ thuộc câu)
function extractMovieNameByIntent(originalText = "") {
  let t = normalizeText(originalText);

  // bỏ cụm intent "thông tin phim"
  t = t
    .replace(/\b(thong tin phim|xem thong tin phim|chi tiet phim|noi dung phim|gioi thieu phim)\b/g, "")
    .replace(/\btoi muon\b/g, "")
    .replace(/\bxem\b/g, "")
    .replace(/\bphim\b/g, "");

  // nếu có "va" thì lấy vế trước
  t = t.split(" va ")[0];

  t = t.replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t : null;
}

// =========================================================
//  DANH SÁCH "PHIM ĐANG CHIẾU": CHỈ HIỆN TÊN 
// =========================================================
async function fetchMoviesFromJava() {
  const loadingMsg = appendMessage("<i> Đang kết nối dữ liệu hệ thống...</i>", 'bot');

  try {
    const [moviesAll, cinemas] = await Promise.all([
      fetchMovies(true),     // lấy danh sách phim
      fetchCinemas(false)    // lấy danh sách rạp (cache ok)
    ]);

    // Lọc theo “có suất chiếu hôm nay”
    const todayYMD = getTodayYMD_VN();
    const movies = await filterMoviesWithShowtimesToday(moviesAll, cinemas, {
      todayYMD,
      limitMovies: 120,    
      limitCinemas: 15,     
      concurrency: 6
    });

    loadingMsg.remove();

    if (!movies || movies.length === 0) {
      appendMessage(
        `🎬 <b>Hôm nay (${escapeHtml(todayYMD)}) chưa có suất chiếu.</b><br/>Bạn có thể thử lại sau nhé.`,
        "bot"
      );
      scheduleQuickReplies(["Rạp chiếu phim", "Giá vé", "Làm sao để đặt vé?"]);
      lastMoviesListShown = false;
      return;
    }

    let reply = `🎬 <b>Phim có suất chiếu hôm nay (${escapeHtml(todayYMD)}):</b><br/><br/>`;
    movies.forEach((movie, idx) => {
      reply += `🎬 ${idx + 1}. <b>${escapeHtml(movie.title)}</b><br/>`;
    });

    reply += "<br/>👉 Bấm vào tên phim để xem chi tiết:";
    appendMessage(reply, 'bot');

    if (quickReplyTimer) clearTimeout(quickReplyTimer);
    setTimeout(() => addMovieButtons(movies), 50);

    lastMoviesListShown = true;
    lastMoviesSignature = movies.map(m => getMovieId(m) + ":" + (m.title || "")).join("|");

  } catch (error) {
    console.error("Error:", error);
    loadingMsg.innerHTML = "Không thể kết nối tới server Java.";
  }
}

//hiển thị toàn bộ phim đang chiếu
async function fetchNowShowingAll() {
  const loadingMsg = appendMessage("<i>Đang tải danh sách phim đang chiếu...</i>", "bot");

  try {
    const moviesAll = await fetchMovies(true); // lấy /api/movies
    loadingMsg.remove();

    if (!moviesAll || moviesAll.length === 0) {
      appendMessage("🎬 Hiện chưa có phim trong hệ thống.", "bot");
      scheduleQuickReplies(["Phim chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
      return;
    }

    const movies = moviesAll.slice(0, 120);

    let reply = `🎬 <b>Danh sách phim đang chiếu:</b><br/><br/>`;
    movies.forEach((movie, idx) => {
      reply += `🎬 ${idx + 1}. <b>${escapeHtml(movie.title)}</b><br/>`;
    });

    reply += "<br/>👉 Bấm vào tên phim để xem chi tiết:";
    appendMessage(reply, "bot");

    if (quickReplyTimer) clearTimeout(quickReplyTimer);
    setTimeout(() => addMovieButtons(movies), 50);

    lastMoviesListShown = true;
    lastMoviesSignature = movies.map(m => getMovieId(m) + ":" + (m.title || "")).join("|");
  } catch (e) {
    console.error(e);
    loadingMsg.innerHTML = "Không tải được danh sách phim.";
  }
}

// =========================================================
//  RẠP (RIÊNG) + GIÁ VÉ (RIÊNG) + LỊCH CHIẾU
// =========================================================

//  Chỉ hiển thị danh sách rạp (KHÔNG cần chọn phim)
async function showCinemasOnly() {
  const loading = appendMessage("<i>Đang tải danh sách rạp...</i>", "bot");

  try {
    const cinemas = await fetchCinemas();
    loading.remove();

    let header = `🏢 <b>Rạp chiếu phim</b><br/>`;

    let html = "";
    if (cinemas.length === 0) {
      html = "— Chưa có rạp trong hệ thống.<br/>";
    } else {
      cinemas.slice(0, 15).forEach((c, i) => {
        const province = c.provinceName ? ` (${escapeHtml(c.provinceName)})` : "";
        html += `• ${i + 1}. <b>${escapeHtml(c.cinemaName)}</b>${province}<br/>`;
      });
      if (cinemas.length > 15) html += `… và ${cinemas.length - 15} rạp khác<br/>`;
    }

    appendMessage(header + html, "bot");

    scheduleQuickReplies([
      "Giá vé",
      "Phim đang chiếu hôm nay",
      "Làm sao để đặt vé?"
    ]);
  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không tải được danh sách rạp.";
  }
}

//  Chỉ hiển thị GIÁ VÉ (từ seat_types) (KHÔNG qua FAQ)
async function showTicketPricesOnly() {
  const loading = appendMessage("<i>Đang tải bảng giá vé...</i>", "bot");

  try {
    const seatTypes = await fetchSeatTypes();
    loading.remove();

    if (seatTypes.length === 0) {
      appendMessage("💰 Hiện chưa có dữ liệu giá vé.", "bot");
      scheduleQuickReplies([
        "Rạp chiếu phim",
        "Phim đang chiếu hôm nay",
        "Làm sao để đặt vé?"
      ]);
      return;
    }

    let html = "💰 <b>Bảng giá vé theo loại ghế</b><br/><br/>";
    seatTypes.forEach(t => {
      html += `• ${escapeHtml(t.seatTypeName)}: <b>${formatPrice(t.price)}</b><br/>`;
    });

    appendMessage(html, "bot");

    scheduleQuickReplies([
      "Rạp chiếu phim",
      "Phim đang chiếu hôm nay",
      "Làm sao để đặt vé?"
    ]);

  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không tải được bảng giá vé.";
  }
}

//Danh sách lịch chiếu thành HTML hiển thị trong chatbot
function formatShowtimes(scheduleList) {
  if (!Array.isArray(scheduleList) || scheduleList.length === 0) {
    return "— Chưa có lịch chiếu cho lựa chọn này.<br/>";
  }

  let html = "";
  scheduleList.forEach(day => {
    const viDay = toVietnameseDayName(day.dayOfWeek);
    const viDate = formatDateVi(day.date);

    html += `📅 <b>${escapeHtml(viDay)}${viDate ? ` - ${escapeHtml(viDate)}` : ""}</b><br/>`;


    const showTimes = Array.isArray(day.showTimes) ? day.showTimes : [];
    if (showTimes.length === 0) {
      html += `— Chưa có suất chiếu<br/><br/>`;
      return;
    }

    const byRoom = {};
    showTimes.forEach(st => {
      const room = st.roomName || "Phòng ?";
      if (!byRoom[room]) byRoom[room] = [];
      byRoom[room].push(st);
    });

    Object.keys(byRoom).forEach(room => {
      const times = byRoom[room]
      .map(st => {
        const timeTxt = formatTimeVi(st.time, "colon"); // hoặc "text"
        return `${escapeHtml(timeTxt)}${st.format ? ` (${escapeHtml(st.format)})` : ""}`;
      })
      .join(" • ");

      html += `🏟 <b>${escapeHtml(room)}</b>: ${times}<br/>`;
    });

    html += `<br/>`;
  });

  return html;
}

// Đổi tên thứ sang tiếng Việt (hỗ trợ: MONDAY, Monday, Mon, T2...)
function toVietnameseDayName(dayOfWeek = "") {
  const s = String(dayOfWeek || "").trim().toLowerCase();

  const map = {
    // full
    "monday": "Thứ Hai",
    "tuesday": "Thứ Ba",
    "wednesday": "Thứ Tư",
    "thursday": "Thứ Năm",
    "friday": "Thứ Sáu",
    "saturday": "Thứ Bảy",
    "sunday": "Chủ Nhật",

    // short
    "mon": "Thứ Hai",
    "tue": "Thứ Ba",
    "tues": "Thứ Ba",
    "wed": "Thứ Tư",
    "thu": "Thứ Năm",
    "thur": "Thứ Năm",
    "thurs": "Thứ Năm",
    "fri": "Thứ Sáu",
    "sat": "Thứ Bảy",
    "sun": "Chủ Nhật",

    // java enum
    "mon_day": "Thứ Hai",
    "tues_day": "Thứ Ba",
    "wednes_day": "Thứ Tư",
    "thurs_day": "Thứ Năm",
    "fri_day": "Thứ Sáu",
    "satur_day": "Thứ Bảy",
    "sun_day": "Chủ Nhật",
  };

  // enum kiểu: MONDAY
  const s2 = s.replace(/\s+/g, "");
  if (map[s2]) return map[s2];

  // trường hợp MONDAY (không có dấu gạch)
  const up = s.toUpperCase();
  if (up === "MONDAY") return "Thứ Hai";
  if (up === "TUESDAY") return "Thứ Ba";
  if (up === "WEDNESDAY") return "Thứ Tư";
  if (up === "THURSDAY") return "Thứ Năm";
  if (up === "FRIDAY") return "Thứ Sáu";
  if (up === "SATURDAY") return "Thứ Bảy";
  if (up === "SUNDAY") return "Chủ Nhật";

  // nếu backend đã trả tiếng Việt sẵn thì giữ nguyên
  return dayOfWeek || "";
}

// Format ngày theo kiểu Việt Nam dd/MM/yyyy (hỗ trợ "2026-01-11", "2026/01/11", "11-01-2026"...)
function formatDateVi(dateStr = "") {
  const raw = String(dateStr || "").trim();
  if (!raw) return "";

  // YYYY-MM-DD hoặc YYYY/MM/DD
  const m1 = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m1) {
    const y = Number(m1[1]), mo = Number(m1[2]) - 1, d = Number(m1[3]);
    const dt = new Date(y, mo, d);
    if (!isNaN(dt.getTime())) return dt.toLocaleDateString("vi-VN");
    return raw;
  }

  // DD-MM-YYYY hoặc DD/MM/YYYY
  const m2 = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m2) {
    const d = Number(m2[1]), mo = Number(m2[2]) - 1, y = Number(m2[3]);
    const dt = new Date(y, mo, d);
    if (!isNaN(dt.getTime())) return dt.toLocaleDateString("vi-VN");
    return raw;
  }

  // ISO datetime hoặc dạng khác -> thử Date.parse
  const dt = new Date(raw);
  if (!isNaN(dt.getTime())) return dt.toLocaleDateString("vi-VN");

  // fallback: trả nguyên
  return raw;
}

// Format giờ theo kiểu Việt Nam: "14:30" hoặc "14 giờ 30"
function formatTimeVi(timeValue = "", style = "colon") {
  const raw = String(timeValue ?? "").trim();
  if (!raw) return "";

  // Case A: ISO datetime "2026-01-11T14:30:00" / "...Z"
  // -> lấy HH:mm từ chuỗi để TRÁNH lệch timezone khi new Date(...)
  const iso = raw.match(/T(\d{2}):(\d{2})/);
  if (iso) {
    const hh = iso[1], mm = iso[2];
    return style === "text" ? `${hh} giờ ${mm}` : `${hh}:${mm}`;
  }

  // Case B: "14:30" / "14:30:00" / "14:30:00.000"
  const hm = raw.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const hh = hm[1].padStart(2, "0");
    const mm = hm[2];
    return style === "text" ? `${hh} giờ ${mm}` : `${hh}:${mm}`;
  }

  // Case C: "1430" (hiếm) -> 14:30
  const digits = raw.match(/^(\d{2})(\d{2})$/);
  if (digits) {
    const hh = digits[1], mm = digits[2];
    return style === "text" ? `${hh} giờ ${mm}` : `${hh}:${mm}`;
  }

  // Fallback: trả nguyên
  return raw;
}




//Hiển thị lịch chiếu + giá vé cho 1 rạp cụ thể
async function showShowtimesForCinema(cinema, movieSnapshot = null) {
  const loading = appendMessage("<i>Đang tải lịch chiếu & giá vé...</i>", "bot");

  try {
    const movieObj = movieSnapshot || appState.selectedMovie;
    const movieId = getMovieId(movieObj);

    if (!movieId) {
      loading.remove();
      appendMessage("Mình chưa xác định được <b>mã phim</b>. Bạn chọn lại phim giúp mình nhé.", "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay"]);
      return;
    }

    const [scheduleList, seatTypes] = await Promise.all([
      fetchShowtimesGrouped(movieId, cinema.id),
      fetchSeatTypes()
    ]);

    loading.remove();

    let pricesHtml = "";
    if (seatTypes.length === 0) {
      pricesHtml = "— Chưa có dữ liệu giá vé.<br/>";
    } else {
      seatTypes.forEach(t => {
        pricesHtml += `• ${escapeHtml(t.seatTypeName)}: <b>${formatPrice(t.price)}</b><br/>`;
      });
    }

    appendMessage(
      `⏰ <b>Lịch chiếu</b><br/>
        🎬 <b>Phim:</b> ${escapeHtml(movieObj?.title || "Không rõ")}<br/>
        🏢 <b>Rạp:</b> ${escapeHtml(cinema.cinemaName)}${cinema.provinceName ? ` (${escapeHtml(cinema.provinceName)})` : ""}<br/><br/>
        ${formatShowtimes(scheduleList)}
        <br/>💰 <b>Giá vé theo loại ghế</b><br/>${pricesHtml}`,
      "bot"
    );

    // + Dọn trạng thái sau khi show lịch chiếu
    appState.selectedMovie = null;
    appState.pendingShowtimes = false;

    scheduleQuickReplies(["Giá vé", "Rạp chiếu phim", "Phim đang chiếu hôm nay", "Làm sao để đặt vé?"]);

  } catch (e) {
    console.error(e);
    loading.innerHTML = " Không tải được lịch chiếu/giá vé.";
  }
}


//Kiểm tra xem câu người dùng có đang hỏi về lịch chiếu / giờ chiếu hay không
function isShowtimeQuery(lowerText) {
  lowerText = (lowerText || "").toLowerCase();
  return (
    lowerText.includes("giờ chiếu") ||
    lowerText.includes("suất chiếu") ||
    lowerText.includes("lịch chiếu") ||
    lowerText.includes("chiếu lúc") ||
    lowerText.includes("phòng chiếu") ||
    lowerText.includes("phòng mấy") ||
    lowerText.includes("room")
  );
}

//Hỏi người dùng chọn rạp để xem lịch chiếu cho phim đang chọn
async function promptPickCinemaForSelectedMovie() {
  if (!appState.selectedMovie) return;

  const loading = appendMessage("<i>Bạn muốn xem lịch chiếu ở rạp nào?</i>", "bot");
  try {
    const cinemas = await fetchCinemas();
    loading.remove();

    if (!cinemas || cinemas.length === 0) {
      appendMessage("Xin lỗi, mình hiện chưa có rạp trong hệ thống.", "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Giá vé", "Làm sao để đặt vé?"]);
      return;
    }

    appendMessage(
      `🏢 <b>Bạn hãy chọn rạp để xem lịch chiếu nhé</b><br/>
      🎬 <b>Phim:</b> ${escapeHtml(appState.selectedMovie.title)}<br/>
      👉 Bấm vào rạp bên dưới:`,
      "bot"
    );

    // Hiện nút rạp -> click sẽ gọi showShowtimesForCinema(cinema)
    if (quickReplyTimer) clearTimeout(quickReplyTimer);
    const movieSnapshot = appState.selectedMovie; // + snapshot phim
    setTimeout(() => {
      addCinemaButtons(cinemas.slice(0, 15), async (cinema) => {
        await showShowtimesForCinema(cinema, movieSnapshot);
      });
    }, 50);

  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không tải được danh sách rạp.";
  }
}

/*
Xử lý intent "xem lịch chiếu" từ câu người dùng
  Xác định user đang muốn tra lịch chiếu của PHIM nào
  Nếu xác định được 1 phim → show thông tin phim trước, rồi hỏi có muốn xem lịch chiếu không
  Nếu nhiều phim → cho user chọn bằng nút
  Nếu không có → hỏi user nhập lại
*/
async function handleShowtimeIntentFromText(originalText) {
  const text = (originalText || "").trim();

  // ✅ Luồng mới: show info trước, rồi hỏi có muốn xem lịch chiếu không
  const loading = appendMessage("<i>Đang xác định phim bạn muốn tra lịch chiếu...</i>", "bot");

  try {
    // bóc keyword phim tốt hơn
    const movieQ = extractMovieKeywordSmart(text) || extractMovieQuery(text) || text;

    const movies = await searchMovies(movieQ);
    loading.remove();

    if (movies.length === 1) {
      appState.selectedMovie = movies[0];
      appendMessage(formatMovieDetail(movies[0]), "bot");

      // ✅ KHÔNG tự hiện rạp nữa
      appState.pendingShowtimes = true;
      askWantShowtimes();
      return true;
    }

    if (movies.length > 1) {
      const top = movies.slice(0, 10);
      let reply = `🔎 Mình thấy <b>${movies.length}</b> phim khớp với "<b>${escapeHtml(movieQ)}</b>".<br/>`;
      reply += `👉 Bạn bấm chọn 1 phim:<br/><br/>`;
      top.forEach((m, idx) => {
        reply += `🎬 ${idx + 1}. <b>${escapeHtml(m.title)}</b><br/>`;
      });
      appendMessage(reply, "bot");

      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      setTimeout(() => addMovieButtons(top), 50);
      return true;
    }

    appendMessage("Xin lỗi, mình chưa nhận ra phim bạn muốn xem lịch chiếu. Bạn nhập đúng <b>tên phim</b> giúp mình nhé.", "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return true;

  } catch (e) {
    console.error(e);
    loading.innerHTML = "Không thể tra lịch chiếu lúc này.";
    return true;
  }
}

// =========================================================
//  XỬ LÝ TIN NHẮN CHÍNH (USER GÕ + ENTER)  
// =========================================================
async function sendMessage() {
  const input = document.getElementById('userInput');
  const text = input.value.trim();
  if (!text) return;

  appendMessage(escapeHtml(text), 'user');

  input.value = '';
  input.style.height = 'auto';

  const loadingMsg = appendMessage("<i>Đang xử lý...</i>", "bot");

  try{
    // + Nếu đang chờ xác nhận lịch chiếu, cho phép user trả lời tự nhiên
    if (appState.pendingShowtimes && appState.selectedMovie) {
      if (isNo(text)) {
        loadingMsg.remove();
        appState.pendingShowtimes = false;
        const lastTitle = appState.selectedMovie?.title || "";
        appState.selectedMovie = null;
        appendMessage(`Khi nào bạn cần lịch chiếu cho <b>${escapeHtml(lastTitle)}</b> bạn nhắn lại nhé.`, "bot");
        scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
        return;
      }
      if (isYes(text)) {
        loadingMsg.remove();
        appState.pendingShowtimes = false;
        await promptPickCinemaForSelectedMovie();
        return;
      }

      // Nếu user nhắn nội dung khác (không phải có/không) 
      appState.pendingShowtimes = false;
      appState.selectedMovie = null;
    }



  if (normalizeText(text) === normalizeText("✅ Xem lịch chiếu")) {
    loadingMsg.remove();
    if (!appState.selectedMovie) {
      appendMessage("❓ Bạn muốn xem lịch chiếu phim nào? Hãy nhập tên phim trước nhé.", "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim"]);
      return;
    }
    appState.pendingShowtimes = false;
    await promptPickCinemaForSelectedMovie();
    return;
  }

  if (normalizeText(text) === normalizeText("Không cần")) {
    loadingMsg.remove();
    appState.pendingShowtimes = false;
    const lastTitle = appState.selectedMovie?.title || "";
    appState.selectedMovie = null;
    appendMessage(`Vậy, khi nào cần lịch chiếu cho <b>${escapeHtml(lastTitle)}</b> bạn nhắn lại nhé.`, "bot");

    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return;
  }

  const intentRes = detectIntent(text);
  const intent = intentRes.intent;
  const norm = normalizeText(text);

  if (shouldUseGeminiOrchestrator(intentRes, text)) {
    loadingMsg.remove();

    const stopTyping = startBotTyping("Gemini đang điều phối yêu cầu");
    try {
      const { plan, raw } = await callGeminiPlan(text);
      stopTyping();

      if (plan && typeof plan === "object") {
        await runAiPlan(plan, text);
        return;
      }

      // nếu không parse JSON được thì fallback trả lời raw
      if (raw && String(raw).trim()) {
        appendMessage(escapeHtml(raw), "bot");
        scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
        return;
      }
    } catch (e) {
      stopTyping();
      console.warn("Gemini orchestrator failed:", e);
      // nếu AI lỗi thì cho rơi xuống flow cũ (không return)
    }
  }

  if (appState.pendingShowtimes && intent && intent !== "GREETING") {
    appState.pendingShowtimes = false;
  }

  // AI-FIRST: câu hỏi tư vấn/gợi ý -> gọi AI trước khi rơi vào searchMovies
  if (shouldAskAiFirst(text)) {
    loadingMsg.remove();
    const stopTyping = startBotTyping("AI đang suy nghĩ");
    try {
      const aiData = await callAiChat(text);
      stopTyping();
      renderAiResult(aiData);
    } catch (e) {
      stopTyping();
      console.warn("AI-FIRST failed:", e);
      appendMessage("Mình chưa gọi được AI lúc này. Bạn thử lại sau nhé.", "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"], 50);
    }
    return;
  }

  

  // Ưu tiên xử lý "rạp + thành phố" trước khi rơi vào nhánh tìm phim
  if (looksLikeCinemaByCity(text) || shouldFilterCinemasByCity(text)) {
    loadingMsg.remove();
    if (await showCinemasByCity(text)) return;
  }

  // rule-based: "hôm nay" + "chiếu" + "phim" => NOW_SHOWING
  if (
    norm.includes("hom nay") &&
    (norm.includes("chieu") || norm.includes("dang chieu")) &&
    norm.includes("phim")
  ) {
    loadingMsg.remove();
    await fetchMoviesFromJava();
    return;
  }

  //  user gõ: "Phim + tên phim" → bóc chữ "phim" để search
  if (
    shouldTreatAsMovieLookup(text, intentRes) &&
    norm.startsWith("phim ") &&
    !norm.includes("dang chieu") &&
    !norm.includes("hom nay")
  ) {
    loadingMsg.remove();

    const q = normalizeSequelNumber(
      text.replace(/^\s*phim\s+/i, "").trim()
    );
    const moviesFound = await searchMovies(q);

    if (moviesFound.length === 1) {
      const id = getMovieId(moviesFound[0]);
      const full = id ? await fetchMovieDetailById(id) : null;
      appState.selectedMovie = full || moviesFound[0];
      appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
      appState.pendingShowtimes = true;
      askWantShowtimes();
    }

    if (moviesFound.length > 1) {
      const top = moviesFound.slice(0, 10);
      let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim khớp với "<b>${escapeHtml(q)}</b>":<br/><br/>`;
      top.forEach((m, i) => reply += `🎬 ${i + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
      reply += "<br/>👉 Bạn bấm chọn 1 phim:";
      appendMessage(reply, "bot");

      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      setTimeout(() => addMovieButtons(top), 50);
      return;
    }

    appendMessage(`Xin lỗi, mình không tìm thấy phim "<b>${escapeHtml(q)}</b>".`, "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return;
  }

  // RESET
  if (intent === "RESET") {
    loadingMsg.remove();
    resetChatbot();
    return;
  }

  // SHOWTIMES (nếu lọt xuống đây)
  if (intent === "SHOWTIMES" || isShowtimeQuery(text.toLowerCase())) {
    loadingMsg.remove();
    const movieQ = extractMovieQuery(text) || text;
    await handleShowtimeIntentFromText(movieQ);
    return;
  }

  // CINEMAS
  if (intent === "CINEMAS") {
    loadingMsg.remove();
    if (appState.pendingShowtimes) {
      appState.pendingShowtimes = false;
      appState.selectedMovie = null;
    }
    if (await showCinemasByCity(text)) return;
    await showCinemasOnly();
    return;
  }

  // TICKET_PRICE
  if (intent === "TICKET_PRICE") {
    loadingMsg.remove();
    await showTicketPricesOnly();
    return;
  }

  // TODAY_SHOWING (lọc suất chiếu hôm nay)
  if (intent === "TODAY_SHOWING") {
    loadingMsg.remove();
    await fetchMoviesFromJava();
    return;
  }

  // NOW_SHOWING (tất cả phim đang chiếu - không lọc suất chiếu)
  if (intent === "NOW_SHOWING") {
    loadingMsg.remove();
    await fetchNowShowingAll();
    return;
  }

  // GENRE
  if (await showMoviesByGenre(text)) {
    loadingMsg.remove();
    return;
  }

  // SMART FLOW: gộp MOVIE_INFO + SHOWTIMES
  const wantsInfo = hasIntent(text, "MOVIE_INFO");
  const wantsShowtimes = hasIntent(text, "SHOWTIMES") || isShowtimeQuery(text.toLowerCase());

  if (wantsInfo || wantsShowtimes) {
    const movieQ = extractMovieKeywordSmart(text) || extractMovieQuery(text) || text;

    const moviesFound = await searchMovies(movieQ);
    loadingMsg.remove();

    if (moviesFound.length === 1) {
      const id = getMovieId(moviesFound[0]);
      const full = id ? await fetchMovieDetailById(id) : null;
      appState.selectedMovie = full || moviesFound[0];
      appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
      appState.pendingShowtimes = true;
      askWantShowtimes();
      return;
    }

    if (moviesFound.length > 1) {
      const top = moviesFound.slice(0, 10);
      let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim khớp với "<b>${escapeHtml(movieQ)}</b>":<br/><br/>`;
      top.forEach((m, i) => reply += `🎬 ${i + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
      reply += "<br/>👉 Bạn bấm chọn 1 phim:";
      appendMessage(reply, "bot");

      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      setTimeout(() => addMovieButtons(top), 50);
      return;
    }

    appendMessage("Xin lỗi, mình chưa tìm thấy phim bạn nhắc tới. Bạn thử nhập ngắn gọn: <b>Avatar</b>.", "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return;
  }

  // BOOKING
  if (looksLikeBookWithMovie(text)) {
    const cleanQ =
      extractMovieKeywordSmart(text) ||
      extractMovieQuery(text) ||
      normalizeText(text).replace(/\bphim\b/g, "").trim() ||
      text;
    const moviesFound = await searchMovies(cleanQ);
    loadingMsg.remove();

    if (moviesFound.length === 1) {
      const id = getMovieId(moviesFound[0]);
      const full = id ? await fetchMovieDetailById(id) : null;
      appState.selectedMovie = full || moviesFound[0];
      appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
      appState.pendingShowtimes = true;
      askWantShowtimes();
      return;
    }

    if (moviesFound.length > 1) {
      const top = moviesFound.slice(0, 10);
      let reply = `Mình tìm thấy <b>${moviesFound.length}</b> phim phù hợp với "<b>${escapeHtml(cleanQ)}</b>":<br/><br/>`;
      top.forEach((m, idx) => reply += `🎬 ${idx + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
      reply += "<br/>👉 Bấm vào tên phim để xem chi tiết:";
      appendMessage(reply, "bot");
      if (quickReplyTimer) clearTimeout(quickReplyTimer);
      setTimeout(() => addMovieButtons(top), 50);
      return;
    }

    const reply = getBotReply(text);
    if (reply) appendMessage(reply, "bot");
    return;
  }

  // FAQ
  if (intent === "HOW_TO_BOOK" || intent === "PAYMENT" || isFaqQuery(text.toLowerCase())) {
    loadingMsg.remove();
    const reply = getBotReply(text);
    if (reply) appendMessage(reply, "bot");
    return;
  }

  if (intent === "HELP") {
    loadingMsg.remove();
    appendMessage(
      `<b>Mình có thể giúp bạn:</b><br/>
      • Tra cứu <b>phim</b> theo tên<br/>
      • Xem <b>lịch chiếu</b> (có hỏi xác nhận)<br/>
      • Xem <b>danh sách rạp</b><br/>
      • Xem <b>giá vé</b><br/>`,
      "bot"
    );
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé", "Làm sao để đặt vé?"]);
    return;
  }

  if (intent === "GREETING") {
    loadingMsg.remove();
    appendMessage(`Xin chào 👋 Bạn muốn tra cứu phim nào?`, "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé", "Đặt vé xem phim"]);
    return;
  }


  // MOVIE_INFO: user hỏi thông tin phim (chỉ hiện info, không hiện lịch chiếu)
  if (intent === "MOVIE_INFO") {
    loadingMsg.remove();

    const movieQ = extractMovieNameByIntent(text) || extractMovieQuery(text) || text;
    const moviesFound = await searchMovies(movieQ);

    if (moviesFound.length === 1) {
      const id = getMovieId(moviesFound[0]);
      const full = id ? await fetchMovieDetailById(id) : null;
      appState.selectedMovie = full || moviesFound[0];
      appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
      appState.pendingShowtimes = true;
      askWantShowtimes();
      return;
    }

    if (moviesFound.length > 1) {
      const top = moviesFound.slice(0, 10);
      let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim khớp với "<b>${escapeHtml(movieQ)}</b>":<br/><br/>`;
      top.forEach((m, idx) => reply += `🎬 ${idx + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
      reply += "<br/>👉 Bạn bấm chọn 1 phim:";
      appendMessage(reply, "bot");
      setTimeout(() => addMovieButtons(top), 50);
      return;
    }

    appendMessage(`Xin lỗi, mình không tìm thấy phim "<b>${escapeHtml(movieQ)}</b>". Bạn thử nhập ngắn gọn: <b>Avatar</b>.`, "bot");
    scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
    return;
  }


  // fallback search phim
  let moviesFound = await searchMovies(text);
  if (!moviesFound || moviesFound.length === 0) {
    moviesFound = await fuzzySearchMovies(text, 0.6);
  }

  loadingMsg.remove();

  if (moviesFound.length === 1) {
    const id = getMovieId(moviesFound[0]);
    const full = id ? await fetchMovieDetailById(id) : null;
    appState.selectedMovie = full || moviesFound[0];
    appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
    appState.pendingShowtimes = true;
    askWantShowtimes();
    return;
  }

  if (moviesFound.length > 1) {
    const top = moviesFound.slice(0, 10);
    let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim phù hợp với "<b>${escapeHtml(text)}</b>":<br/><br/>`;
    top.forEach((m, idx) => reply += `🎬 ${idx + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
    reply += "<br/>👉 Bấm vào tên phim để xem chi tiết:";
    appendMessage(reply, "bot");
    if (quickReplyTimer) clearTimeout(quickReplyTimer);
    setTimeout(() => addMovieButtons(top), 50);
    return;
  }

  // city cinemas fallback
  if (await showCinemasByCity(text)) return;
  const stopTyping2 = startBotTyping("Đang phân tích yêu cầu");

  //  AI fallback (Gemini): thông minh hơn nhưng không bịa dữ liệu
  try {
    const { plan, raw } = await callGeminiPlan(text);
    stopTyping2();

    // nếu parse được JSON -> chạy action
    if (plan && typeof plan === "object") {
      await runAiPlan(plan, text);
      return;
    }

    if (raw && String(raw).trim()) {
      appendMessage(escapeHtml(raw), "bot");
      scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
      return;
    }
  } catch (e) {
    stopTyping2();
    console.warn("AI fallback failed:", e);
  }

  // fallback cũ nếu AI lỗi
  const reply = getBotReply(text);
  if (reply) appendMessage(reply, "bot");


  } catch (error) {
    console.error("Lỗi:", error);
    loadingMsg.innerHTML = "Không thể xử lý yêu cầu. Bạn thử lại sau nhé!";
  }
}


// =========================================================
//  XỬ LÝ QUICK MESSAGE (KHI USER BẤM NÚT)  
// =========================================================
async function sendQuickMessage(text) {
  appendMessage(escapeHtml(text), 'user');
  const loadingMsg = appendMessage("<i>Đang xử lý...</i>", "bot");

  try {
      const norm = normalizeText(text);
      // Nếu đang chờ xác nhận lịch chiếu, cho phép user trả lời tự nhiên
      if (appState.pendingShowtimes && appState.selectedMovie && isNo(text)) {
        loadingMsg.remove();
        appState.pendingShowtimes = false;
        const lastTitle = appState.selectedMovie?.title || "";
        appState.selectedMovie = null;
        appendMessage(`Oke ✅ Khi nào cần lịch chiếu cho <b>${escapeHtml(lastTitle)}</b> bạn nhắn lại nhé.`, "bot");
        scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
        return;
      }
      if (appState.pendingShowtimes && appState.selectedMovie && isYes(text)) {
        loadingMsg.remove();
        appState.pendingShowtimes = false;
        await promptPickCinemaForSelectedMovie();
        return;
      }

      // Quick message khác "có/không": chỉ hủy pending nếu đang pending
      if (appState.pendingShowtimes) appState.pendingShowtimes = false;


      //  xử lý nút xác nhận
      if (normalizeText(text) === normalizeText("✅ Xem lịch chiếu")) {
        loadingMsg.remove();
        if (!appState.selectedMovie) {
          appendMessage("❓ Bạn muốn xem lịch chiếu phim nào? Hãy nhập tên phim trước nhé.", "bot");
          scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim"]);
          return;
        }
        appState.pendingShowtimes = false;
        await promptPickCinemaForSelectedMovie();
        return;
      }

      if (normalizeText(text) === normalizeText("Không cần")) {
        loadingMsg.remove();
        appState.pendingShowtimes = false;
        appState.selectedMovie = null;
        appendMessage("Khi nào bạn cần lịch chiếu bạn nhắn lại giúp mình nhé.", "bot");
        scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
        return;
      }

      // Phải detectIntent trước khi dùng intent
      const intentRes = detectIntent(text);
      const intent = intentRes.intent;

      if (
        norm.includes("hom nay") &&
        norm.includes("phim") &&
        (norm.includes("chieu") || norm.includes("dang chieu"))
      ) {
        loadingMsg.remove();
        await fetchMoviesFromJava();
        return;
      }

      if (shouldUseGeminiOrchestrator(intentRes, text)) {
        loadingMsg.remove();

        const stopTyping = startBotTyping("Gemini đang điều phối yêu cầu");
        try {
          const { plan, raw } = await callGeminiPlan(text);
          stopTyping();

          if (plan && typeof plan === "object") {
            await runAiPlan(plan, text);
            return;
          }

          if (raw && String(raw).trim()) {
            appendMessage(escapeHtml(raw), "bot");
            scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
            return;
          }
        } catch (e) {
          stopTyping();
          console.warn("Gemini orchestrator failed:", e);
        }
      }


      //AI-FIRST cho quick message (nếu user bấm nút tư vấn/gợi ý)
      if (shouldAskAiFirst(text)) {
        loadingMsg.remove();

        const stopTyping = startBotTyping("AI đang suy nghĩ");
        try {
          const aiData = await callAiChat(text);
          stopTyping();
          renderAiResult(aiData);
        } catch (e) {
          stopTyping();
          console.warn("AI-FIRST failed:", e);
          appendMessage("Mình chưa gọi được AI lúc này. Bạn thử lại sau nhé.", "bot");
          scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"], 50);
        }
        return;
      }


      // Ưu tiên xử lý "rạp + thành phố"
      if (looksLikeCinemaByCity(text) || shouldFilterCinemasByCity(text)) {
        loadingMsg.remove();
        if (await showCinemasByCity(text)) return;
      }

      //  RESET
      if (intent === "RESET") {
        loadingMsg.remove();
        resetChatbot();
        return;
      }

      // TODAY_SHOWING (lọc suất chiếu hôm nay)
      if (intent === "TODAY_SHOWING") {
        loadingMsg.remove();
        await fetchMoviesFromJava();
        return;
      }

      // NOW_SHOWING (tất cả phim đang chiếu - không lọc suất chiếu)
      if (intent === "NOW_SHOWING") {
        loadingMsg.remove();
        await fetchNowShowingAll();
        return;
      }


      //  CINEMAS
      if (intent === "CINEMAS") {
        loadingMsg.remove();
        if (appState.pendingShowtimes) {
          appState.pendingShowtimes = false;
          appState.selectedMovie = null;
        }
        if (await showCinemasByCity(text)) return;
        await showCinemasOnly();
        return;
      }

      //  TICKET_PRICE
      if (intent === "TICKET_PRICE") {
        loadingMsg.remove();
        await showTicketPricesOnly();
        return;
      }

      //  FAQ: HOW_TO_BOOK / PAYMENT
      if (intent === "HOW_TO_BOOK" || intent === "PAYMENT" || isFaqQuery(text)) {
        loadingMsg.remove();
        const reply = getBotReply(text);
        if (reply) appendMessage(reply, "bot");
        return;
      }

      //  GENRE
      if (await showMoviesByGenre(text)) {
        loadingMsg.remove();
        return;
      }

      //  SMART FLOW: chỉ chạy sau khi đã xử lý quick buttons ở trên
      const wantsInfo = hasIntent(text, "MOVIE_INFO");
      const wantsShowtimes = hasIntent(text, "SHOWTIMES") || isShowtimeQuery(text);

      if (wantsInfo || wantsShowtimes) {
        const cleanQ =
          extractMovieKeywordSmart(text) ||
          extractMovieQuery(text) ||
          normalizeText(text).replace(/\bphim\b/g, "").trim() ||
          text;
        const moviesFound = await searchMovies(cleanQ);
        loadingMsg.remove();

        if (moviesFound.length === 1) {
          const id = getMovieId(moviesFound[0]);
          const full = id ? await fetchMovieDetailById(id) : null;
          appState.selectedMovie = full || moviesFound[0];
          appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
          appState.pendingShowtimes = true;
          askWantShowtimes();
          return;
        }

        if (moviesFound.length > 1) {
          const top = moviesFound.slice(0, 10);
          let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim khớp với "<b>${escapeHtml(cleanQ)}</b>":<br/><br/>`;
          top.forEach((m, i) => reply += `🎬 ${i + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
          reply += "<br/>👉 Bạn bấm chọn 1 phim:";
          appendMessage(reply, "bot");

          if (quickReplyTimer) clearTimeout(quickReplyTimer);
          setTimeout(() => addMovieButtons(top), 50);
          return;
        }

        appendMessage("Mình chưa tìm thấy phim bạn nhắc tới. Bạn thử nhập ngắn gọn: <b>Avatar</b>.", "bot");
        scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
        return;
      }

      // fallback search phim theo text
      const moviesFound = await searchMovies(text);
      loadingMsg.remove();

      if (moviesFound.length === 1) {
        const id = getMovieId(moviesFound[0]);
        const full = id ? await fetchMovieDetailById(id) : null;
        appState.selectedMovie = full || moviesFound[0];
        appendMessage(formatMovieDetail(appState.selectedMovie), "bot");
        appState.pendingShowtimes = true;
        askWantShowtimes();
        return;
      }

      if (moviesFound.length > 1) {
        const top = moviesFound.slice(0, 10);
        let reply = `🔎 Mình tìm thấy <b>${moviesFound.length}</b> phim phù hợp với "<b>${escapeHtml(text)}</b>":<br/><br/>`;
        top.forEach((m, idx) => reply += `🎬 ${idx + 1}. <b>${escapeHtml(m.title)}</b><br/>`);
        reply += "<br/>👉 Bấm vào tên phim để xem chi tiết:";
        appendMessage(reply, "bot");
        if (quickReplyTimer) clearTimeout(quickReplyTimer);
        setTimeout(() => addMovieButtons(top), 50);
        return;
      }

      //  AI fallback (Gemini) cho cả quick message
      const stopTyping2 = startBotTyping("Gemini đang phân tích yêu cầu");
      try {
        const { plan, raw } = await callGeminiPlan(text);
        stopTyping2();

        if (plan && typeof plan === "object") {
          await runAiPlan(plan, text);
          return;
        }

        if (raw && String(raw).trim()) {
          appendMessage(escapeHtml(raw), "bot");
          scheduleQuickReplies(["Phim đang chiếu hôm nay", "Rạp chiếu phim", "Giá vé"]);
          return;
        }
      } catch (e) {
        stopTyping2();
        console.warn("AI fallback failed:", e);
      }


      const reply = getBotReply(text);
      if (reply) appendMessage(reply, "bot");


  } catch (e) {
    console.error(e);
    loadingMsg.innerHTML = " Không thể xử lý lúc này.";
  }
}

// =========================
// AUTO DATA REFRESH 
// =========================
let autoRefreshTimer = null;
let lastMoviesSignature = "";
let lastMoviesListShown = false;
let warmupInFlight = false;


async function invalidateAndWarmup() {
  // chỉ chạy khi chatbot đang mở (tiết kiệm tài nguyên)
  const botOpen = document.getElementById("chatbot")?.classList.contains("show");
  if (!botOpen) return;

  // chống chạy chồng khi interval tới mà vòng trước chưa xong
  if (warmupInFlight) return;
  warmupInFlight = true;

  try {
    console.log("🔄 Auto refresh data...");

    // clear cache để lần sau fetch... buộc lấy mới
    appState.cinemasCache = null;
    appState.cinemasCacheAt = 0;
    appState.seatTypesCache = null;
    appState.seatTypesCacheAt = 0;

    // nên clear cả moviesCache để đồng bộ với check phim mới
    appState.moviesCache = null;
    appState.moviesCacheAt = 0;

    CITY_INDEX_READY = false;

    //  warmup song song, không block UI
    const tasks = [
      fetchCinemas(true),
      fetchSeatTypes(true),
      buildCityIndexFromCinemas(),
      fetchMovies(true),
    ];

    const results = await Promise.allSettled(tasks);

    // 3) kiểm tra phim mới (chỉ khi fetchMovies thành công)
    const moviesRes = results[3];
    if (moviesRes.status === "fulfilled") {
      const moviesAll = Array.isArray(moviesRes.value) ? moviesRes.value : [];
      const cinemas = await fetchCinemas(false);

      const todayYMD = getTodayYMD_VN();
      const movies = await filterMoviesWithShowtimesToday(moviesAll, cinemas, {
        todayYMD,
        limitMovies: 120,
        limitCinemas: 15,
        concurrency: 6
      });

      const sig = movies
        .map(m => `${getMovieId(m)}:${normalizeText(m.title || "")}:${m.releaseDate || ""}`)
        .sort()
        .join("|");


      if (!lastMoviesSignature) {
        lastMoviesSignature = sig;
      } else if (sig && sig !== lastMoviesSignature) {
        lastMoviesSignature = sig;
      }
    }
  } catch (e) {
    console.warn("invalidateAndWarmup failed:", e);
  } finally {
    warmupInFlight = false;
  }
}



function startAutoRefresh() {
  if (autoRefreshTimer) return;

  // chạy ngay 1 lần khi mở chatbot
  invalidateAndWarmup();

  // sau đó refresh định kỳ
  autoRefreshTimer = setInterval(invalidateAndWarmup, 90 * 1000); // ✅ 90s
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  const bot = document.getElementById("chatbot");
  const isOpen = bot && bot.classList.contains("show");
  if (!isOpen) return;

  if (document.hidden) stopAutoRefresh();
  else startAutoRefresh();
});

