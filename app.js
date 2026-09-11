/* ============================================================================
 * BrainCode Academy — Automated Interview (Frontend)
 * Phase 1: интервью + MediaRecorder + сохранение ответов.
 * Phase 2/3 (транскрибация + AI-анализ) выполняются на backend и не влияют
 * на работу интервью. См. README.md.
 * ==========================================================================*/

/* ----------------------------- 1. КОНФИГУРАЦИЯ --------------------------- */

const CONFIG = {
  // URL Web App из Google Apps Script (заканчивается на /exec)
  API_URL: "https://script.google.com/macros/s/AKfycbzT3FvlLLbxaWr2q8H6mEcNBCku53gdVjFgEiU68FP2QH7Q0gG1jMPoXc7R8wXvC_9q5Q/exec",

  ANSWER_TIME_SECONDS: 60,
  // 0 = запись стартует сразу вместе с показом вопроса (кандидат не успевает
  // подготовить ответ через ИИ). Поставьте 3-5, если нужна пауза на подготовку.
  PREPARATION_TIME_SECONDS: 0,
  API_TIMEOUT_MS: 15000,

  // Загрузка видео
  UPLOAD_VIDEO: true,             // false -> запись остаётся локальной, в таблицу пишется только metadata
  UPLOAD_TIMEOUT_MS: 90000,       // таймаут на один чанк / финализацию
  UPLOAD_CHUNK_CHARS: 700 * 1024, // размер чанка base64 (~700 КБ текста на запрос)
  UPLOAD_MAX_ATTEMPTS: 3,         // попыток на каждый чанк

  // Качество записи (меньше битрейт -> быстрее и надёжнее загрузка)
  VIDEO_BITS_PER_SECOND: 700000,
  AUDIO_BITS_PER_SECOND: 64000,
  MEDIA_CONSTRAINTS: {
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: "user"
    },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  },

  DEBUG: true
};

/* Вопросы интервью. Текст можно свободно менять — порядок = номер вопроса. */
const QUESTIONS = [
  {
    number: 1,
    text: "Расскажите коротко о себе и почему вы хотите обучаться в BrainCode Academy?"
  },
  {
    number: 2,
    text: "Почему вы выбрали именно это IT-направление?"
  },
  {
    number: 3,
    text: "Обучение длится 6 месяцев и требует регулярного участия. Как вы планируете совмещать обучение с работой, учёбой или другими обязанностями?"
  },
  {
    number: 4,
    text: "Расскажите о ситуации, когда вам пришлось самостоятельно изучить что-то сложное или решить непростую проблему. Что вы сделали?"
  },
  {
    number: 5,
    text: "Почему именно вы должны получить грант TechOrda и что вы планируете делать после завершения обучения?"
  }
];

/* ------------------------------- 2. STATE -------------------------------- */

const state = {
  candidateId: null,
  candidate: null,
  currentQuestion: 0,      // 0 = интервью ещё не начато; 1..5 = текущий вопрос
  stream: null,
  mediaRecorder: null,
  chunks: [],
  recording: false,
  isStoppingAnswer: false,

  // служебное
  screen: "loading",
  mimeType: "",
  stopHandled: false,
  answerStartedAt: 0,
  pendingAnswer: null,     // { blob, questionNumber, durationSeconds, mimeType } — для повторной отправки
  interviewFinished: false,
  timers: { prep: null, rec: null, watchdog: null }
};

/* ------------------------- 3. УТИЛИТЫ И ЛОГИ ----------------------------- */

function log() {
  if (!CONFIG.DEBUG) return;
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[Interview]"].concat(args));
}
function logError() {
  const args = Array.prototype.slice.call(arguments);
  console.error.apply(console, ["[Interview]"].concat(args));
}

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}
function show(id, visible) {
  const el = $(id);
  if (el) el.hidden = !visible;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return mm + ":" + ss;
}
function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

/* --------------------- 4. УПРАВЛЕНИЕ ЭКРАНАМИ (STATES) -------------------- */

const SCREENS = {
  "loading":        "screen-loading",
  "invalid-link":   "screen-invalid-link",
  "error":          "screen-error",
  "candidate-info": "screen-candidate",
  "permissions":    "screen-permissions",
  "instructions":   "screen-instructions",
  "preparation":    "screen-interview",
  "recording":      "screen-interview",
  "saving":         "screen-interview",
  "completed":      "screen-completed"
};
const CAMERA_SCREENS = ["permissions", "instructions", "preparation", "recording", "saving"];

function setScreen(name) {
  if (!SCREENS[name]) {
    logError("unknown screen:", name);
    name = "error";
  }
  state.screen = name;
  log("screen ->", name);

  const targetId = SCREENS[name];
  const shownIds = {};
  Object.keys(SCREENS).forEach((key) => { shownIds[SCREENS[key]] = true; });
  Object.keys(shownIds).forEach((id) => {
    const el = $(id);
    if (el) el.hidden = (id !== targetId);
  });

  // камера
  show("cameraPanel", CAMERA_SCREENS.indexOf(name) !== -1 && !!state.stream);
  show("camBadge", name === "recording");
  show("recTimer", name === "recording");

  // внутренние блоки экрана интервью
  show("prepBlock", name === "preparation");
  show("recBlock", name === "recording");
  show("savingBlock", name === "saving");

  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
}

function renderError(message, options) {
  const opts = options || {};
  clearAllTimers();
  setText("errorTitle", opts.title || "Произошла ошибка");
  setText("errorMessage", message || "Неизвестная ошибка.");

  const detailsEl = $("errorDetails");
  if (opts.details) {
    detailsEl.textContent = opts.details;
    detailsEl.hidden = false;
  } else {
    detailsEl.hidden = true;
  }

  const icon = $("errorIcon");
  if (opts.variant === "info") {
    icon.className = "icon icon--ok";
    icon.textContent = "i";
  } else {
    icon.className = "icon icon--warn";
    icon.textContent = "!";
  }

  const retryBtn = $("errorRetry");
  retryBtn.hidden = !opts.onRetry;
  retryBtn.disabled = false;
  retryBtn.textContent = opts.retryLabel || "Повторить";
  retryBtn.onclick = null;
  if (opts.onRetry) {
    retryBtn.onclick = function () {
      retryBtn.disabled = true;
      try {
        opts.onRetry();
      } catch (err) {
        logError("retry handler failed", err);
        retryBtn.disabled = false;
      }
    };
  }

  setScreen("error");
}

/* ------------------------------ 5. API-СЛОЙ ------------------------------ */

function ApiError(message, code, details) {
  this.name = "ApiError";
  this.message = message;
  this.code = code || "unknown";
  this.details = details || "";
}
ApiError.prototype = Object.create(Error.prototype);
ApiError.prototype.constructor = ApiError;

function isApiConfigured() {
  return !!CONFIG.API_URL &&
    CONFIG.API_URL.indexOf("PUT_") !== 0 &&
    CONFIG.API_URL.indexOf("http") === 0;
}

/**
 * Единая точка обращения к backend.
 * GET:  apiRequest({ action: "getCandidate", candidateId }, { method: "GET" })
 * POST: apiRequest({ action: "saveAnswer", ... })
 *
 * Всегда возвращает { success, data } / { success:false, error } либо бросает
 * ApiError. Никогда не оставляет UI в подвешенном состоянии.
 */
async function apiRequest(payload, options) {
  const opts = options || {};
  const method = (opts.method || "POST").toUpperCase();
  const timeoutMs = opts.timeoutMs || CONFIG.API_TIMEOUT_MS;

  if (!isApiConfigured()) {
    throw new ApiError(
      "Система интервью ещё не настроена. Обратитесь в BrainCode Academy.",
      "not_configured",
      "CONFIG.API_URL не задан в app.js"
    );
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("Нет подключения к интернету. Проверьте связь и попробуйте снова.", "offline");
  }

  let url = CONFIG.API_URL;
  const fetchOptions = { method: method, redirect: "follow" };

  if (method === "GET") {
    const qs = new URLSearchParams();
    Object.keys(payload || {}).forEach((k) => {
      if (payload[k] !== undefined && payload[k] !== null) qs.append(k, String(payload[k]));
    });
    url += (url.indexOf("?") === -1 ? "?" : "&") + qs.toString();
  } else {
    // text/plain -> простой запрос без CORS preflight (обязательно для Apps Script)
    fetchOptions.headers = { "Content-Type": "text/plain;charset=utf-8" };
    fetchOptions.body = JSON.stringify(payload || {});
  }

  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  if (controller) fetchOptions.signal = controller.signal;
  const timer = setTimeout(() => { if (controller) controller.abort(); }, timeoutMs);

  const logPayload = Object.assign({}, payload);
  if (logPayload.data) logPayload.data = "[base64 " + String(logPayload.data).length + " chars]";
  log("API request", method, logPayload);

  let rawText = "";
  try {
    const response = await fetch(url, fetchOptions);
    rawText = await response.text();

    if (!response.ok) {
      logError("API HTTP error", response.status, rawText.slice(0, 500));
      throw new ApiError(
        "Сервер вернул ошибку (" + response.status + "). Попробуйте ещё раз.",
        "http_" + response.status,
        rawText.slice(0, 300)
      );
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch (parseErr) {
      logError("API returned non-JSON. Raw response:", rawText.slice(0, 1000));
      throw new ApiError(
        "Сервер вернул некорректный ответ. Проверьте настройки доступа Web App.",
        "bad_json",
        rawText.slice(0, 300)
      );
    }

    const normalized = normalizeResponse(json);
    log("API response", normalized);
    return normalized;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err && (err.name === "AbortError" || err.code === 20)) {
      throw new ApiError(
        "Не удалось подключиться к серверу. Проверьте интернет и попробуйте снова.",
        "timeout"
      );
    }
    logError("API request failed", err);
    throw new ApiError(
      "Не удалось подключиться к серверу. Проверьте интернет и попробуйте снова.",
      "network",
      (err && err.message) || ""
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Поддерживает оба формата ответа:
 *   новый:  { success: true, data: {...} }
 *   старый: { success: true, candidateId: "...", name: "..." }
 */
function normalizeResponse(json) {
  if (!json || typeof json !== "object") {
    throw new ApiError("Сервер вернул некорректный ответ.", "bad_format");
  }
  if (json.success === false) {
    return {
      success: false,
      error: json.error || "Неизвестная ошибка сервера.",
      code: json.code || null
    };
  }
  if (json.success !== true) {
    throw new ApiError("Сервер вернул некорректный ответ.", "bad_format", JSON.stringify(json).slice(0, 300));
  }

  const merged = {};
  Object.keys(json).forEach((key) => {
    if (key !== "success" && key !== "data") merged[key] = json[key];
  });
  if (json.data && typeof json.data === "object") {
    Object.keys(json.data).forEach((key) => { merged[key] = json.data[key]; });
  }
  return { success: true, data: merged };
}

/* -------------- 6. ХРАНИЛИЩЕ / ТРАНСКРИБАЦИЯ / АНАЛИЗ (интерфейсы) ------- */
/* Эти функции намеренно изолированы: замена Google Drive на Firebase/Supabase
   или смена AI-провайдера не затрагивает остальной код интервью.
   transcribeRecording / analyzeAnswer / analyzeFullInterview — это Phase 2/3:
   во время интервью они НЕ вызываются (кандидат не ждёт AI) и требуют
   adminToken. Они существуют как готовые точки входа для будущей админки.   */

/**
 * Загрузка записи. Возвращает объект результата и НИКОГДА не бросает исключение:
 * сбой загрузки не должен прерывать интервью.
 * @returns {Promise<{ok:boolean, storage:string, url:string|null, fileId:string|null,
 *                    error:string|null, localUrl:string|null, sizeBytes:number, mimeType:string}>}
 */
async function uploadRecording(blob, candidateId, questionNumber) {
  const result = {
    ok: false,
    storage: "local",
    url: null,
    fileId: null,
    error: null,
    localUrl: null,
    sizeBytes: blob ? blob.size : 0,
    mimeType: (blob && blob.type) || state.mimeType || "video/webm"
  };

  if (!blob || !blob.size) {
    result.error = "empty_recording";
    logError("uploadRecording: пустая запись");
    return result;
  }

  // Локальная ссылка доступна всегда (полезно для отладки).
  try { result.localUrl = URL.createObjectURL(blob); } catch (e) { /* noop */ }

  if (!CONFIG.UPLOAD_VIDEO) {
    result.error = "upload_disabled";
    return result;
  }

  try {
    const base64 = await blobToBase64(blob);
    const uploadId = candidateId + "_Q" + questionNumber + "_" + Date.now();
    const chunkSize = CONFIG.UPLOAD_CHUNK_CHARS;
    const totalChunks = Math.max(1, Math.ceil(base64.length / chunkSize));
    log("upload start", { questionNumber: questionNumber, bytes: blob.size, base64: base64.length, totalChunks: totalChunks });

    for (let i = 0; i < totalChunks; i++) {
      const chunk = base64.slice(i * chunkSize, (i + 1) * chunkSize);
      await postWithRetry({
        action: "uploadChunk",
        candidateId: candidateId,
        questionNumber: questionNumber,
        uploadId: uploadId,
        chunkIndex: i,
        totalChunks: totalChunks,
        data: chunk
      }, "чанк " + (i + 1) + "/" + totalChunks);
      updateSavingProgress(i + 1, totalChunks);
    }

    const finalizeRes = await postWithRetry({
      action: "finalizeUpload",
      candidateId: candidateId,
      questionNumber: questionNumber,
      uploadId: uploadId,
      totalChunks: totalChunks,
      mimeType: result.mimeType,
      sizeBytes: blob.size
    }, "финализация");

    if (finalizeRes.success) {
      result.ok = true;
      result.storage = finalizeRes.data.storage || "google-drive";
      result.url = finalizeRes.data.fileUrl || null;
      result.fileId = finalizeRes.data.fileId || null;
      log("upload done", result.url);
    } else {
      result.error = finalizeRes.error || "finalize_failed";
      logError("upload finalize failed", result.error);
    }
  } catch (err) {
    result.error = (err && err.message) || "upload_failed";
    logError("upload failed", err);
  }
  return result;
}

/**
 * PHASE 2 (backend). Транскрибация выполняется на стороне Apps Script и
 * кандидатом не ожидается. Функция — явная точка расширения (админка / ручной
 * повтор для одного ответа).
 */
async function transcribeRecording(recordingUrl, candidateId, questionNumber, adminToken) {
  log("transcribeRecording -> backend", { candidateId: candidateId, questionNumber: questionNumber });
  return apiRequest({
    action: "transcribeAnswer",
    adminToken: adminToken || null,
    candidateId: candidateId,
    questionNumber: questionNumber,
    recordingUrl: recordingUrl || null
  }, { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS });
}

/** PHASE 3 (backend). Анализ одного ответа. Ключ AI хранится только на backend. */
async function analyzeAnswer(question, transcript, questionNumber, adminToken) {
  log("analyzeAnswer -> backend", { questionNumber: questionNumber });
  return apiRequest({
    action: "analyzeAnswer",
    adminToken: adminToken || null,
    candidateId: state.candidateId,
    questionNumber: questionNumber,
    question: question,
    transcript: transcript
  }, { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS });
}

/** PHASE 3 (backend). Итоговый анализ интервью (backend запускает его сам). */
async function analyzeFullInterview(candidate, transcripts, adminToken) {
  const candidateId = (candidate && candidate.candidateId) || state.candidateId;
  log("analyzeFullInterview -> backend", { candidateId: candidateId });
  return apiRequest({
    action: "reanalyzeInterview",
    adminToken: adminToken || null,
    candidateId: candidateId,
    transcripts: transcripts || null
  }, { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS });
}

async function postWithRetry(payload, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await apiRequest(payload, { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS });
      if (res.success) return res;
      // Логическую ошибку сервера повторять бессмысленно
      throw new ApiError(res.error || "Ошибка загрузки", "upload_rejected");
    } catch (err) {
      lastError = err;
      if (err instanceof ApiError && err.code === "upload_rejected") throw err;
      logError("upload retry (" + label + ") attempt " + attempt, err && err.message);
      if (attempt < CONFIG.UPLOAD_MAX_ATTEMPTS) await sleep(1200 * attempt);
    }
  }
  throw lastError || new ApiError("Не удалось загрузить запись", "upload_failed");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать запись"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      // ВАЖНО: mimeType может содержать запятую ("video/webm;codecs=vp9,opus"),
      // поэтому ищем именно маркер ";base64,", а не первую запятую.
      const marker = ";base64,";
      const idx = dataUrl.indexOf(marker);
      if (idx !== -1) {
        resolve(dataUrl.slice(idx + marker.length));
        return;
      }
      const comma = dataUrl.indexOf(",");
      resolve(comma === -1 ? dataUrl : dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function updateSavingProgress(done, total) {
  if (state.screen !== "saving") return;
  const percent = Math.min(99, Math.round((done / total) * 100));
  setText("savingHint", "Загружено " + percent + "%. Не закрывайте страницу.");
}

/* ----------------------------- 7. МЕДИА ---------------------------------- */

function isMediaSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    typeof window.MediaRecorder !== "undefined";
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
    "video/mp4"
  ];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (let i = 0; i < candidates.length; i++) {
    if (MediaRecorder.isTypeSupported(candidates[i])) {
      log("mimeType selected:", candidates[i]);
      return candidates[i];
    }
  }
  log("mimeType: используем настройки браузера по умолчанию");
  return "";
}

async function requestMedia() {
  setScreen("permissions");
  setText("permTitle", "Доступ к камере и микрофону");
  setText("permText", "Разрешите доступ к камере и микрофону в окне браузера.");
  show("permHint", false);
  show("btnRetryPermissions", false);

  if (!isMediaSupported()) {
    renderError(
      "Ваш браузер не поддерживает запись видео (MediaRecorder). Откройте ссылку в Google Chrome, Microsoft Edge или Safari последней версии.",
      { title: "Браузер не поддерживается" }
    );
    return false;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(CONFIG.MEDIA_CONSTRAINTS);
    log("media permission granted");

    const hasAudio = state.stream.getAudioTracks().length > 0;
    const hasVideo = state.stream.getVideoTracks().length > 0;
    if (!hasAudio || !hasVideo) {
      stopMedia();
      showPermissionProblem(!hasVideo
        ? "Камера не найдена или занята другим приложением."
        : "Микрофон не найден или занят другим приложением.");
      return false;
    }

    const video = $("preview");
    video.srcObject = state.stream;
    show("cameraPanel", true);
    try { await video.play(); } catch (e) { log("video.play() отложен", e && e.name); }

    return true;
  } catch (err) {
    logError("getUserMedia failed", err && err.name, err && err.message);
    const name = (err && err.name) || "";
    let hint;
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      hint = "Нажмите на значок камеры в адресной строке браузера, разрешите доступ и нажмите «Попробовать снова».";
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      hint = "Устройство не найдено: подключите камеру и микрофон.";
    } else if (name === "NotReadableError" || name === "TrackStartError") {
      hint = "Камера или микрофон уже используются другой программой (Zoom, Meet, Skype). Закройте её и попробуйте снова.";
    } else if (name === "OverconstrainedError") {
      hint = "Камера не поддерживает требуемые параметры. Попробуйте другое устройство или браузер.";
    } else {
      hint = "Техническая информация: " + (name || "неизвестная ошибка");
    }
    showPermissionProblem(hint);
    return false;
  }
}

function showPermissionProblem(hint) {
  setScreen("permissions");
  setText("permTitle", "Нет доступа к камере или микрофону");
  setText("permText", "Для прохождения интервью необходимо разрешить доступ к камере и микрофону.");
  setText("permHint", hint || "");
  show("permHint", !!hint);
  show("cameraPanel", false);
  const btn = $("btnRetryPermissions");
  btn.hidden = false;
  btn.disabled = false;
}

function stopMedia() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) { /* noop */ }
    });
    log("media tracks stopped");
  }
  state.stream = null;
  const video = $("preview");
  if (video) video.srcObject = null;
  show("cameraPanel", false);
}

/* --------------------------- 8. ТАЙМЕРЫ ---------------------------------- */

function clearAllTimers() {
  Object.keys(state.timers).forEach((key) => {
    if (state.timers[key]) {
      clearInterval(state.timers[key]);
      clearTimeout(state.timers[key]);
      state.timers[key] = null;
    }
  });
}

/* -------------------------- 9. ЛОГИКА ИНТЕРВЬЮ --------------------------- */

function getCandidateIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("candidate") || params.get("candidateId") || "";
  return raw.trim();
}

async function init() {
  log("init");
  bindGlobalHandlers();
  setScreen("loading");

  state.candidateId = getCandidateIdFromUrl();
  log("candidateId:", state.candidateId || "(отсутствует)");

  if (!state.candidateId) {
    setScreen("invalid-link");
    return;
  }
  await loadCandidate();
}

async function loadCandidate() {
  setScreen("loading");
  setText("loadingText", "Проверяем ссылку на интервью...");

  let res;
  try {
    res = await apiRequest(
      { action: "getCandidate", candidateId: state.candidateId },
      { method: "GET" }
    );
  } catch (err) {
    renderError(err.message, {
      title: "Нет связи с сервером",
      details: CONFIG.DEBUG ? (err.code + (err.details ? " — " + err.details : "")) : "",
      onRetry: loadCandidate
    });
    return;
  }

  if (!res.success) {
    const error = String(res.error || "");
    if (/already completed|уже.*заверш/i.test(error)) {
      renderError(
        "Это интервью уже было завершено. Ваши ответы сохранены, повторное прохождение недоступно.",
        { title: "Интервью уже завершено", variant: "info" }
      );
    } else if (/not found|не найден/i.test(error)) {
      renderError(
        "Кандидат по этой ссылке не найден. Проверьте, что ссылка из письма BrainCode Academy скопирована полностью.",
        { title: "Кандидат не найден" }
      );
    } else {
      renderError(error || "Не удалось получить данные кандидата.", {
        title: "Ошибка",
        onRetry: loadCandidate
      });
    }
    return;
  }

  state.candidate = res.data;
  renderCandidateInfo();
}

function renderCandidateInfo() {
  const c = state.candidate || {};
  const name = (c.name || "").toString().trim();
  setText("candidateGreeting", name ? ("Здравствуйте, " + name + "!") : "Здравствуйте!");

  if (c.course) {
    setText("candidateCourse", "Направление: " + c.course);
    show("candidateCourse", true);
  } else {
    show("candidateCourse", false);
  }

  const answered = Number(c.answeredCount || 0);
  const status = c.status || c.interviewStatus || "NOT_STARTED";
  if (status === "IN_PROGRESS" && answered > 0 && answered < QUESTIONS.length) {
    setText("candidateNotice",
      "Вы уже начинали интервью: сохранено ответов — " + answered + " из " + QUESTIONS.length +
      ". Вы продолжите с вопроса №" + (answered + 1) + ".");
    show("candidateNotice", true);
    state.currentQuestion = answered; // продолжаем со следующего
  } else {
    show("candidateNotice", false);
    state.currentQuestion = 0;
  }

  const hasPrep = CONFIG.PREPARATION_TIME_SECONDS > 0;
  setText("prepSecondsHint", String(CONFIG.PREPARATION_TIME_SECONDS));
  setText("answerSecondsHint", String(CONFIG.ANSWER_TIME_SECONDS));
  setText("answerSecondsInfo", String(CONFIG.ANSWER_TIME_SECONDS));
  show("prepInfoLine", hasPrep);
  show("noPrepInfoLine", !hasPrep);
  show("prepHintLine", hasPrep);
  $("btnStart").disabled = false;
  setScreen("candidate-info");
}

async function onStartInterviewClick() {
  const btn = $("btnStart");
  if (btn.disabled) return;      // защита от двойного клика
  btn.disabled = true;
  log("start interview clicked");

  const granted = await requestMedia();
  if (!granted) {
    btn.disabled = false;
    return;
  }
  $("btnBeginQuestions").disabled = false;
  setScreen("instructions");
}

async function onRetryPermissionsClick() {
  const btn = $("btnRetryPermissions");
  if (btn.disabled) return;
  btn.disabled = true;

  const granted = await requestMedia();
  if (granted) {
    $("btnBeginQuestions").disabled = false;
    setScreen("instructions");
  } else {
    btn.disabled = false;
  }
}

async function onBeginQuestionsClick() {
  const btn = $("btnBeginQuestions");
  if (btn.disabled) return;
  btn.disabled = true;

  setScreen("saving");
  setText("savingText", "Подготавливаем интервью...");
  setText("savingHint", "Это займёт пару секунд.");

  try {
    const res = await apiRequest({ action: "startInterview", candidateId: state.candidateId });
    if (!res.success) {
      if (/already completed|уже.*заверш/i.test(String(res.error))) {
        stopMedia();
        renderError("Это интервью уже было завершено.", { title: "Интервью уже завершено", variant: "info" });
        return;
      }
      throw new ApiError(res.error || "Не удалось начать интервью", "start_failed");
    }
    if (res.data && typeof res.data.answeredCount !== "undefined") {
      const answered = Number(res.data.answeredCount) || 0;
      if (answered > 0 && answered < QUESTIONS.length) state.currentQuestion = answered;
    }
  } catch (err) {
    renderError(err.message || "Не удалось начать интервью.", {
      title: "Не удалось начать интервью",
      onRetry: function () {
        $("btnBeginQuestions").disabled = false;
        setScreen("instructions");
      },
      retryLabel: "Попробовать снова"
    });
    return;
  }

  goToQuestion(state.currentQuestion + 1);
}

function goToQuestion(number) {
  if (number > QUESTIONS.length) {
    finishInterview();
    return;
  }
  log("next question", number);

  state.currentQuestion = number;
  state.chunks = [];
  state.isStoppingAnswer = false;
  state.stopHandled = false;
  state.recording = false;
  state.pendingAnswer = null;

  const question = QUESTIONS[number - 1];
  const percent = Math.round((number / QUESTIONS.length) * 100);
  setText("progressLabel", "Вопрос " + number + " из " + QUESTIONS.length);
  setText("progressPercent", percent + "%");
  const fill = $("progressFill");
  if (fill) fill.style.width = percent + "%";
  setText("questionText", question.text);

  startPreparation();
}

function startPreparation() {
  clearAllTimers();

  // Подготовка отключена -> вопрос и запись появляются одновременно.
  if (!CONFIG.PREPARATION_TIME_SECONDS || CONFIG.PREPARATION_TIME_SECONDS <= 0) {
    log("preparation skipped (PREPARATION_TIME_SECONDS = 0)");
    startRecording();
    return;
  }

  setScreen("preparation");
  $("btnSkipPrep").disabled = false;

  let left = CONFIG.PREPARATION_TIME_SECONDS;
  setText("prepCountdown", String(left));

  state.timers.prep = setInterval(function () {
    left -= 1;
    if (left <= 0) {
      clearInterval(state.timers.prep);
      state.timers.prep = null;
      startRecording();
      return;
    }
    setText("prepCountdown", String(left));
  }, 1000);
}

function onSkipPrepClick() {
  const btn = $("btnSkipPrep");
  if (btn.disabled) return;
  btn.disabled = true;
  if (state.timers.prep) {
    clearInterval(state.timers.prep);
    state.timers.prep = null;
  }
  startRecording();
}

function startRecording() {
  if (state.recording) return;

  if (!state.stream || state.stream.getTracks().every((t) => t.readyState === "ended")) {
    renderError("Соединение с камерой потеряно. Разрешите доступ и попробуйте снова.", {
      title: "Камера недоступна",
      onRetry: async function () {
        const ok = await requestMedia();
        if (ok) goToQuestion(state.currentQuestion);
      },
      retryLabel: "Подключить камеру"
    });
    return;
  }

  state.chunks = [];
  state.isStoppingAnswer = false;
  state.stopHandled = false;
  state.mimeType = pickMimeType();

  const options = {
    videoBitsPerSecond: CONFIG.VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: CONFIG.AUDIO_BITS_PER_SECOND
  };
  if (state.mimeType) options.mimeType = state.mimeType;

  let recorder = null;
  try {
    recorder = new MediaRecorder(state.stream, options);
  } catch (err) {
    log("MediaRecorder с опциями не создан, пробуем без опций:", err && err.message);
    try {
      recorder = new MediaRecorder(state.stream);
      state.mimeType = recorder.mimeType || "";
    } catch (err2) {
      logError("MediaRecorder недоступен", err2);
      renderError(
        "Ваш браузер не поддерживает запись видео. Откройте ссылку в Google Chrome или Microsoft Edge последней версии.",
        { title: "Запись недоступна" }
      );
      return;
    }
  }

  state.mediaRecorder = recorder;

  recorder.ondataavailable = function (event) {
    if (event.data && event.data.size > 0) state.chunks.push(event.data);
  };
  recorder.onerror = function (event) {
    logError("MediaRecorder error", event && event.error);
    stopAnswer("recorder-error");
  };
  recorder.onstop = function () {
    log("recording stopped");
    handleRecordingStopped();
  };

  try {
    recorder.start(1000); // timeslice: данные копятся по частям — безопаснее при сбоях
  } catch (err) {
    logError("recorder.start failed", err);
    renderError("Не удалось начать запись ответа. Перезагрузите страницу и попробуйте снова.", {
      title: "Ошибка записи",
      onRetry: function () { window.location.reload(); },
      retryLabel: "Перезагрузить страницу"
    });
    return;
  }

  state.recording = true;
  state.answerStartedAt = Date.now();
  log("recording started", { question: state.currentQuestion, mimeType: state.mimeType || "default" });

  const finishBtn = $("btnFinishAnswer");
  finishBtn.disabled = false;
  finishBtn.textContent = "Завершить ответ";

  setScreen("recording");
  startAnswerTimer();
}

function startAnswerTimer() {
  const endsAt = Date.now() + CONFIG.ANSWER_TIME_SECONDS * 1000;
  const timerEl = $("recTimer");
  timerEl.classList.remove("is-low");
  setText("recTimer", formatTime(CONFIG.ANSWER_TIME_SECONDS));

  state.timers.rec = setInterval(function () {
    const leftSeconds = (endsAt - Date.now()) / 1000;
    if (leftSeconds <= 0) {
      clearInterval(state.timers.rec);
      state.timers.rec = null;
      setText("recTimer", formatTime(0));
      log("answer time is over -> auto stop");
      stopAnswer("timeout");
      return;
    }
    setText("recTimer", formatTime(leftSeconds));
    if (leftSeconds <= 10) timerEl.classList.add("is-low");
  }, 250);
}

/** Единственная точка остановки записи. Защищена от двойного вызова. */
function stopAnswer(reason) {
  if (state.isStoppingAnswer) {
    log("stopAnswer ignored (already stopping)");
    return;
  }
  state.isStoppingAnswer = true;
  log("stopAnswer", reason);

  const btn = $("btnFinishAnswer");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Сохраняем...";
  }

  if (state.timers.rec) {
    clearInterval(state.timers.rec);
    state.timers.rec = null;
  }

  // Страховка: если onstop не сработает — продолжаем с уже собранными данными.
  state.timers.watchdog = setTimeout(function () {
    logError("stop watchdog: onstop не сработал, продолжаем");
    handleRecordingStopped();
  }, 6000);

  try {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      if (state.mediaRecorder.requestData) state.mediaRecorder.requestData();
      state.mediaRecorder.stop();
    } else {
      handleRecordingStopped();
    }
  } catch (err) {
    logError("recorder.stop() failed", err);
    handleRecordingStopped();
  }
}

function onFinishAnswerClick() {
  const btn = $("btnFinishAnswer");
  if (btn.disabled || state.isStoppingAnswer) return;
  stopAnswer("user");
}

function handleRecordingStopped() {
  if (state.stopHandled) return;
  state.stopHandled = true;
  state.recording = false;

  if (state.timers.watchdog) {
    clearTimeout(state.timers.watchdog);
    state.timers.watchdog = null;
  }

  const durationSeconds = Math.min(
    CONFIG.ANSWER_TIME_SECONDS,
    Math.round((Date.now() - state.answerStartedAt) / 1000)
  );
  const type = state.mimeType || (state.mediaRecorder && state.mediaRecorder.mimeType) || "video/webm";

  let blob = null;
  try {
    blob = new Blob(state.chunks, { type: type });
  } catch (err) {
    logError("Blob creation failed", err);
  }

  state.pendingAnswer = {
    blob: blob,
    questionNumber: state.currentQuestion,
    durationSeconds: durationSeconds,
    mimeType: type
  };
  log("answer prepared", {
    question: state.currentQuestion,
    seconds: durationSeconds,
    size: blob ? formatMb(blob.size) : "0 MB"
  });

  saveCurrentAnswer();
}

async function saveCurrentAnswer() {
  const pending = state.pendingAnswer;
  if (!pending) {
    logError("saveCurrentAnswer вызван без pendingAnswer");
    goToQuestion(state.currentQuestion + 1);
    return;
  }

  setScreen("saving");
  setText("savingText", "Сохраняем ваш ответ...");
  setText("savingHint", "Не закрывайте страницу.");

  // Шаг 1: загрузка записи (сбой не прерывает интервью)
  const upload = await uploadRecording(pending.blob, state.candidateId, pending.questionNumber);

  // Шаг 2: сохранение в Google Sheets — это критично
  setText("savingHint", "Почти готово...");
  const answerText = (upload.ok && upload.url)
    ? upload.url
    : "RECORDED_LOCALLY | " + pending.durationSeconds + "s | " +
      (pending.blob ? formatMb(pending.blob.size) : "0 MB") + " | " + pending.mimeType +
      " | upload: " + (upload.error || "unknown");

  try {
    const res = await apiRequest({
      action: "saveAnswer",
      candidateId: state.candidateId,
      questionNumber: pending.questionNumber,
      answer: answerText,
      videoUrl: upload.url,
      videoFileId: upload.fileId,
      storage: upload.storage,
      durationSeconds: pending.durationSeconds,
      sizeBytes: upload.sizeBytes,
      mimeType: pending.mimeType
    }, { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS });

    if (!res.success) throw new ApiError(res.error || "Не удалось сохранить ответ", "save_failed");
  } catch (err) {
    logError("saveAnswer failed", err);
    renderError(
      "Не удалось сохранить ответ на вопрос " + pending.questionNumber +
      ". Проверьте интернет и нажмите «Повторить» — запись не потеряна.",
      {
        title: "Ошибка сохранения",
        details: CONFIG.DEBUG ? (err.message || "") : "",
        onRetry: saveCurrentAnswer,
        retryLabel: "Повторить сохранение"
      }
    );
    return;
  }

  // Шаг 3: освобождаем память и идём дальше
  if (upload.localUrl) {
    try { URL.revokeObjectURL(upload.localUrl); } catch (e) { /* noop */ }
  }
  const completedQuestion = pending.questionNumber;
  state.pendingAnswer = null;
  state.chunks = [];

  setText("savingText", "Ответ сохранён ✓");
  setText("savingHint", "Переходим к следующему вопросу...");
  await sleep(900);

  goToQuestion(completedQuestion + 1);
}

async function finishInterview() {
  log("finishing interview");
  clearAllTimers();
  setScreen("saving");
  setText("savingText", "Завершаем интервью...");
  setText("savingHint", "Не закрывайте страницу.");

  try {
    const res = await apiRequest(
      { action: "finishInterview", candidateId: state.candidateId },
      { timeoutMs: CONFIG.UPLOAD_TIMEOUT_MS }
    );
    if (!res.success && !/already completed|уже.*заверш/i.test(String(res.error))) {
      throw new ApiError(res.error || "Не удалось завершить интервью", "finish_failed");
    }
  } catch (err) {
    logError("finishInterview failed", err);
    renderError(
      "Все ответы сохранены, но не удалось отметить интервью завершённым. Нажмите «Повторить».",
      { title: "Почти готово", onRetry: finishInterview, retryLabel: "Повторить" }
    );
    return;
  }

  state.interviewFinished = true;
  stopMedia();

  const name = (state.candidate && state.candidate.name) ? String(state.candidate.name).trim() : "";
  setText("completedName", name ? ("Спасибо, " + name + "!") : "Спасибо!");
  setScreen("completed");
  log("interview completed");
}

/* -------------------------- 10. ГЛОБАЛЬНЫЕ ХЕНДЛЕРЫ ---------------------- */

function bindGlobalHandlers() {
  $("btnStart").addEventListener("click", onStartInterviewClick);
  $("btnRetryPermissions").addEventListener("click", onRetryPermissionsClick);
  $("btnBeginQuestions").addEventListener("click", onBeginQuestionsClick);
  $("btnSkipPrep").addEventListener("click", onSkipPrepClick);
  $("btnFinishAnswer").addEventListener("click", onFinishAnswerClick);

  window.addEventListener("online", function () { show("netBanner", false); });
  window.addEventListener("offline", function () { show("netBanner", true); });
  if (navigator.onLine === false) show("netBanner", true);

  window.addEventListener("beforeunload", function (event) {
    const active = ["preparation", "recording", "saving"].indexOf(state.screen) !== -1;
    if (active && !state.interviewFinished) {
      event.preventDefault();
      event.returnValue = "";
      return "";
    }
  });

  window.addEventListener("unhandledrejection", function (event) {
    logError("unhandled promise rejection", event && event.reason);
  });
}

/* ----------------------------- 11. СТАРТ --------------------------------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
