const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const login = require("ws3-fca");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_APPSTATE = process.env.FB_APPSTATE;
const THREAD_ID = process.env.THREAD_ID;
const WEB_URL = process.env.WEB_URL || "Xem tại trang Web của lớp";

const HISTORY_FILE = "last_quiz.txt";
const DATA_FILE = "data.json";
const MANUAL_DOC = "de_cuong.txt"; // File để bạn dán đề cương thủ công nếu cần

const RSS_URL = "https://news.google.com/rss/search?q=" +
  encodeURIComponent("đáp án cuộc thi tìm hiểu đoàn thanh niên tuần") +
  "&hl=vi&gl=VN&ceid=VN:vi";

async function getQuizSource() {
  if (fs.existsSync(MANUAL_DOC)) {
    const text = fs.readFileSync(MANUAL_DOC, "utf8").trim();
    if (text.length > 20) {
      return { title: "Đề cương Chi đoàn cập nhật", rawText: text };
    }
  }

  const { data } = await axios.get(RSS_URL, { timeout: 15000 });
  const $ = cheerio.load(data, { xmlMode: true });
  const first = $("item").first();
  if (!first.length) return null;

  const title = first.find("title").text().trim();
  const link = first.find("link").text().trim();
  let rawText = title;

  try {
    const page = await axios.get(link, { headers: { "User-Agent": "Mozilla/5.0" } });
    const page$ = cheerio.load(page.data);
    page$("script, style, nav, footer, header").remove();
    rawText = page$("body").text().replace(/\s+/g, " ").trim().slice(0, 15000);
  } catch (e) {}

  return { title, rawText };
}

async function analyzeWithGemini(quiz) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là trợ lý học tập. Xử lý tài liệu thi Đoàn sau: "${quiz.title}".
Vì mỗi máy bị ĐẢO CÂU HỎI và ĐẢO VỊ TRÍ A,B,C,D:
- KHÔNG dùng A/B/C/D đơn thuần, KHÔNG đánh số câu cố định.
- Xuất định dạng JSON DUY NHẤT (không bọc markdown) gồm cấu trúc:
{
  "messengerText": "Bảng tóm tắt từ khóa chống đảo đề ngắn gọn để gửi Group Messenger (định dạng: 🔹 [Từ khóa] 👉 Chọn: [Nội dung chữ đáp án])",
  "questionBank": [
    {
      "kw": "Từ khóa ngắn",
      "q": "Nội dung câu hỏi",
      "a": "Nội dung chữ của đáp án đúng"
    }
  ]
}

Nội dung đề:
${quiz.rawText}
`;

  const result = await model.generateContent(prompt);
  let text = result.response.text().trim();
  text = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(text);
}

function formatAppState(rawJson) {
  return JSON.parse(rawJson).map(c => ({
    key: c.key || c.name,
    value: c.value,
    domain: c.domain || ".facebook.com",
    path: c.path || "/",
    hostOnly: c.hostOnly || false,
    creation: new Date().toISOString(),
    lastAccessed: new Date().toISOString()
  }));
}

function sendToMessenger(text) {
  return new Promise((resolve, reject) => {
    login({ appState: formatAppState(FB_APPSTATE) }, { listenEvents: false }, (err, api) => {
      if (err) return reject(err);
      api.sendMessage(text, THREAD_ID, (e) => e ? reject(e) : resolve());
    });
  });
}

async function main() {
  const quiz = await getQuizSource();
  if (!quiz) return;

  const lastSent = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, "utf8").trim() : "";
  if (quiz.title === lastSent) return;

  const dataAI = await analyzeWithGemini(quiz);

  if (dataAI.questionBank) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataAI.questionBank, null, 2), "utf8");
  }

  const msg = 
    `🚨 ĐÁP ÁN THI ĐOÀN MỚI: ${quiz.title}\n` +
    `⚠️ App đảo đề mỗi máy! Hãy nhìn [Từ khóa] để chọn đúng chữ:\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${dataAI.messengerText}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔍 Tra cứu toàn bộ ngân hàng (gõ 2 chữ là ra): \n👉 ${WEB_URL}`;

  await sendToMessenger(msg);
  fs.writeFileSync(HISTORY_FILE, quiz.title, "utf8");
  if (fs.existsSync(MANUAL_DOC)) fs.writeFileSync(MANUAL_DOC, "", "utf8");
}

main().catch(console.error);
