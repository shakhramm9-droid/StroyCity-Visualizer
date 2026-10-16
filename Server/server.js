require("dotenv").config();

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Настройки (задаются в Render -> Environment)
// ==========================================

// Gemini (запасной вариант)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Forge (локальный ИИ через туннель)
const FORGE_URL = (process.env.FORGE_URL || "").replace(/\/+$/, "");
const FORGE_AUTH = process.env.FORGE_AUTH || ""; // формат: логин:пароль
const FORGE_CHECKPOINT = process.env.FORGE_CHECKPOINT || ""; // необязательно
// Тип модели во Forge: "sd" (SD 1.5 / SDXL, подходит для 4 ГБ видеопамяти) или "flux"
const FORGE_MODEL = (process.env.FORGE_MODEL || "sd").toLowerCase();
// 512 - минимум, 640-768 - заметно чётче (для 4 ГБ видеопамяти ещё ок), 1024 - для мощного ноутбука
const FORGE_MAX_SIDE = parseInt(process.env.FORGE_MAX_SIDE || "640", 10);
const FORGE_STEPS = parseInt(process.env.FORGE_STEPS || "20", 10);
const FORGE_CFG = parseFloat(process.env.FORGE_CFG || "6");
// Сила ИИ при "улучшении": 0.3 = почти как заготовка, 0.5 = реалистично (рекомендуется), 0.7 = ИИ сильно перерисовывает
const FORGE_REFINE_DENOISE = parseFloat(process.env.FORGE_REFINE_DENOISE || "0.5");
// Сколько проходов ИИ: 1 = быстрее, 2 = второй мягкий проход добавляет чёткости (в 2 раза дольше)
const FORGE_PASSES = Math.min(2, Math.max(1, parseInt(process.env.FORGE_PASSES || "1", 10) || 1));
const FORGE_PASS2_DENOISE = parseFloat(process.env.FORGE_PASS2_DENOISE || "0.25");
const FORGE_FULL_RES = process.env.FORGE_FULL_RES !== "false"; // "только маска" в большем разрешении
const FORGE_TIMEOUT_MS = parseInt(process.env.FORGE_TIMEOUT_MS || "300000", 10);
const FORGE_NEGATIVE = process.env.FORGE_NEGATIVE ||
    "cartoon, illustration, painting, drawing, 3d render, cgi, flat colors, plastic, oversaturated, " +
    "repeating texture, tiled pattern, blurry, low quality, deformed, rug, carpet, text, watermark, furniture changes";

// Режим вклейки результата ИИ:
// "hybrid" (по умолчанию) - пол берётся от ИИ (реализм, свет, блики, тени), а цвет подтягивается
//                           к цвету товара из каталога, мелкие швы и зерно возвращаются из заготовки
// "light"  - от ИИ берётся только освещение, пол остаётся заготовкой из браузера (самый "точный", но менее реалистичный)
// "full"   - пол от ИИ целиком (рисунок и цвет могут отличаться от товара)
const BLEND_MODE = (process.env.BLEND_MODE || "hybrid").toLowerCase();
const COLOR_LOCK = parseFloat(process.env.COLOR_LOCK || "0.8");       // 0..1: насколько жёстко держим цвет товара
const DETAIL_MIX = parseFloat(process.env.DETAIL_MIX || "0.5");       // 0..1: сколько мелких швов/зерна вернуть из заготовки
const DETAIL_SIGMA = parseFloat(process.env.DETAIL_SIGMA || "2");     // размер "мелкого" в пикселях
const LIGHT_BLUR = parseFloat(process.env.LIGHT_BLUR || "0.008"); // (режим light) размытие света, доля от большей стороны
const LIGHT_GAIN_MIN = parseFloat(process.env.LIGHT_GAIN_MIN || "0.8");
const LIGHT_GAIN_MAX = parseFloat(process.env.LIGHT_GAIN_MAX || "1.25");
const LIGHT_DETAIL_MIX = parseFloat(process.env.LIGHT_DETAIL_MIX || "0"); // (режим light) 0..1

const RESULT_TTL_MS = parseInt(process.env.RESULT_TTL_MIN || "60", 10) * 60 * 1000;
const MAX_PENDING = parseInt(process.env.MAX_PENDING || "3", 10);
// Защита от спама: не больше N запросов с одного адреса за окно (0 = выключено)
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "20", 10);
const RATE_WINDOW_MS = parseInt(process.env.RATE_WINDOW_MIN || "10", 10) * 60 * 1000;
const FINAL_MAX_SIDE = parseInt(process.env.FINAL_MAX_SIDE || "1600", 10);
const USE_FORGE = process.env.USE_FORGE === "true" && FORGE_URL !== "";

const PUBLIC_URL =
    process.env.PUBLIC_URL || "https://stroycity-visualizer-1.onrender.com";

if (!GEMINI_API_KEY && !USE_FORGE) {
    console.error("ОШИБКА: нет ни GEMINI_API_KEY, ни настроек Forge (USE_FORGE=true и FORGE_URL)");
    process.exit(1);
}

if (!GEMINI_API_KEY) {
    console.warn("ВНИМАНИЕ: GEMINI_API_KEY не задан, запасной вариант Gemini недоступен");
}

// ==========================================
// Описания ламинатов для Forge (по-английски)
// ЗАМЕНИТЕ описания на реальные: цвет и тип дерева
// ==========================================

const FLOOR_DESCRIPTIONS = {
    "Дуб Зигфрид": "dark chocolate brown oak laminate flooring, rich walnut-like color, fine pronounced wood grain with dark streaks and small knots, long planks with thin beveled joints, matte finish",
    "Дуб Виндзор": "light grey whitewashed oak laminate flooring, pale cool grey-white color, visible natural knots and soft wood grain, wide planks with thin joints, matte finish",
    "Дуб Бьерн": "light beige oak laminate flooring, warm sandy greige tone, fine pronounced open-pore wood grain with small knots, long planks, matte natural finish",
    "Дуб Пауэр": "dark smoky grey-brown oak laminate flooring, deep taupe color, pronounced wood grain with knots, long planks with thin dark beveled joints, matte finish",
    "Дуб Кантри": "rustic weathered oak laminate flooring, brushed grey-brown color with light grain lines and reddish-brown dark streaks, aged vintage look, strongly textured surface, matte finish",
    "Дуб Берлин": "very light white-washed oak laminate flooring, almost white with soft grey grain lines, fine open-pore grain, long planks with distinct beveled grooves between them, matte finish"
};

function describeFloor(name) {
    const key = (name || "").trim();
    return FLOOR_DESCRIPTIONS[key] || "oak laminate flooring, wood planks";
}

// ==========================================
// Папка загрузок и multer
// ==========================================

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

// Чистим старые файлы, чтобы диск не забивался
function cleanupUploads() {
    try {
        const now = Date.now();
        fs.readdirSync("uploads").forEach(function (name) {
            const full = path.join("uploads", name);
            try {
                if (now - fs.statSync(full).mtimeMs > RESULT_TTL_MS) {
                    fs.unlinkSync(full);
                }
            } catch (e) { /* файл мог уже пропасть */ }
        });
    } catch (e) {
        console.error("Ошибка очистки uploads:", e.message);
    }
}

cleanupUploads();
setInterval(cleanupUploads, 10 * 60 * 1000);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "uploads");
    },
    filename: function (req, file, cb) {
        const uniqueName =
            Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 } // 15 МБ
});

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }

    next();
});

app.use("/uploads", express.static("uploads"));

// Мягкая защита от спама (чтобы чужие люди не жгли вашу видеокарту)
const rateHits = new Map();

function clientIp(req) {
    return (
        req.headers["cf-connecting-ip"] ||
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress ||
        "unknown"
    );
}

function rateLimit(req, res, next) {
    if (RATE_LIMIT_MAX <= 0) return next();
    const ip = clientIp(req);
    const now = Date.now();
    const list = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: "Слишком много запросов, попробуйте через несколько минут" });
    }
    list.push(now);
    rateHits.set(ip, list);
    next();
}

setInterval(function () {
    const now = Date.now();
    rateHits.forEach(function (list, ip) {
        const fresh = list.filter(t => now - t < RATE_WINDOW_MS);
        if (fresh.length) rateHits.set(ip, fresh); else rateHits.delete(ip);
    });
}, 5 * 60 * 1000);

// Проверка: включён ли ИИ-компьютер (сайт показывает по ней "ИИ онлайн / офлайн")
let forgeState = { ok: false, at: 0 };

async function checkForge() {
    if (!USE_FORGE) return false;
    if (Date.now() - forgeState.at < 15000) return forgeState.ok;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let ok = false;
    try {
        const r = await fetch(FORGE_URL + "/sdapi/v1/progress?skip_current_image=true", {
            headers: forgeHeaders(),
            signal: controller.signal
        });
        ok = r.ok;
    } catch (e) {
        ok = false;
    } finally {
        clearTimeout(timer);
    }
    forgeState = { ok: ok, at: Date.now() };
    return ok;
}

app.get("/health", async (req, res) => {
    res.json({ server: true, ai: await checkForge() });
});

app.get("/", (req, res) => {
    res.send(
        "StroyCity Visualizer Server работает! (" +
            (USE_FORGE ? "Forge + Gemini" : "Gemini") +
            ")"
    );
});

// ==========================================
// Очередь: Forge обрабатывает по одной картинке
// ==========================================

let queue = Promise.resolve();
let pending = 0;

function runExclusive(fn) {
    pending++;
    const run = queue.then(fn);
    queue = run.catch(() => {}).then(() => { pending--; });
    return run;
}

// ==========================================
// Gemini
// ==========================================

async function editImageWithGemini(imageBuffer, mimeType, prompt) {

    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY не задан");
    }

    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: base64Image
                            }
                        },
                        { text: prompt }
                    ]
                }],
                generationConfig: {
                    responseModalities: ["IMAGE"]
                }
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            "Gemini ошибка: " + JSON.stringify(data)
        );
    }

    const parts = data.candidates[0].content.parts;
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
        throw new Error(
            "Gemini не вернул изображение: " + JSON.stringify(data)
        );
    }

    return Buffer.from(imagePart.inlineData.data, "base64");
}

// ==========================================
// Forge (FLUX inpaint)
// ==========================================

// Приводит фото и маску к одному размеру (кратному 16)
async function prepareForForge(roomBuffer, maskBuffer) {

    // Оригинал в хорошем размере (с него потом берётся вся комната, кроме пола)
    const original = await sharp(roomBuffer)
        .rotate()
        .resize({
            width: FINAL_MAX_SIDE,
            height: FINAL_MAX_SIDE,
            fit: "inside",
            withoutEnlargement: true
        })
        .png()
        .toBuffer({ resolveWithObject: true });

    const resized = await sharp(roomBuffer)
        .rotate() // учитывает поворот из EXIF
        .resize({
            width: FORGE_MAX_SIDE,
            height: FORGE_MAX_SIDE,
            fit: "inside",
            withoutEnlargement: true
        })
        .png()
        .toBuffer({ resolveWithObject: true });

    const width = Math.max(64, Math.floor(resized.info.width / 16) * 16);
    const height = Math.max(64, Math.floor(resized.info.height / 16) * 16);

    const roomPng = await sharp(resized.data)
        .resize(width, height, { fit: "fill" })
        .png()
        .toBuffer();

    // Маска: белое = менять (пол), чёрное = оставить
    const maskPng = await sharp(maskBuffer)
        .resize(width, height, { fit: "fill" })
        .greyscale()
        .threshold(128)
        .png()
        .toBuffer();

    return { roomPng, maskPng, width, height, original };
}

// Переносит с картинки ИИ только освещение (тени, блики, перепады яркости),
// не трогая рисунок и цвет досок из заготовки. Цвет товара остаётся точным.
async function transferLighting(originalPng, forgePng, W, H) {

    const sigma = Math.max(4, Math.max(W, H) * LIGHT_BLUR);

    const [o, f, ob, fb] = await Promise.all([
        sharp(originalPng).removeAlpha().raw().toBuffer(),
        sharp(forgePng).removeAlpha().raw().toBuffer(),
        sharp(originalPng).removeAlpha().blur(sigma).raw().toBuffer(),
        sharp(forgePng).removeAlpha().blur(sigma).raw().toBuffer()
    ]);

    const out = Buffer.alloc(W * H * 3);
    const mix = Math.min(1, Math.max(0, LIGHT_DETAIL_MIX));

    for (let i = 0; i < W * H; i++) {

        const p = i * 3;

        const yo = 0.299 * ob[p] + 0.587 * ob[p + 1] + 0.114 * ob[p + 2];
        const yf = 0.299 * fb[p] + 0.587 * fb[p + 1] + 0.114 * fb[p + 2];

        let g = (yf + 4) / (yo + 4);
        g = Math.min(LIGHT_GAIN_MAX, Math.max(LIGHT_GAIN_MIN, g));

        for (let c = 0; c < 3; c++) {
            let v = o[p + c] * g;
            if (mix > 0) v = v * (1 - mix) + f[p + c] * mix;
            out[p + c] = Math.min(255, Math.max(0, Math.round(v)));
        }
    }

    return sharp(out, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toBuffer();
}

// Гибрид: пол от ИИ (реализм, свет, блики) + цвет товара + мелкие швы/зерно из заготовки.
// 1) Цвет: общий коэффициент по каждому каналу тянет средний цвет ИИ-пола к цвету заготовки
//    (локальные свет и тени от ИИ при этом сохраняются).
// 2) Чёткость: ИИ работает в низком разрешении, поэтому тонкие швы и зерно добавляем из заготовки.
async function hybridFloor(originalPng, aiPng, maskAlpha, W, H) {

    const sigma = Math.max(0.5, DETAIL_SIGMA);

    const [o, f, ob] = await Promise.all([
        sharp(originalPng).removeAlpha().raw().toBuffer(),
        sharp(aiPng).removeAlpha().raw().toBuffer(),
        sharp(originalPng).removeAlpha().blur(sigma).raw().toBuffer()
    ]);

    const sumO = [0, 0, 0];
    const sumF = [0, 0, 0];
    let cnt = 0;

    for (let i = 0; i < W * H; i++) {
        if (maskAlpha[i] < 128) continue;
        const p = i * 3;
        for (let c = 0; c < 3; c++) {
            sumO[c] += o[p + c];
            sumF[c] += f[p + c];
        }
        cnt++;
    }

    const lock = Math.min(1, Math.max(0, COLOR_LOCK));
    const mix = Math.min(1, Math.max(0, DETAIL_MIX));
    const gain = [1, 1, 1];

    if (cnt > 50) {
        for (let c = 0; c < 3; c++) {
            const g = Math.pow((sumO[c] / cnt + 1) / (sumF[c] / cnt + 1), lock);
            gain[c] = Math.min(1.6, Math.max(0.6, g));
        }
    }

    const out = Buffer.alloc(W * H * 3);

    for (let i = 0; i < W * H; i++) {
        const p = i * 3;
        for (let c = 0; c < 3; c++) {
            const v = f[p + c] * gain[c] + mix * (o[p + c] - ob[p + c]);
            out[p + c] = Math.min(255, Math.max(0, Math.round(v)));
        }
    }

    return sharp(out, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toBuffer();
}

// Вставляет результат в чёткий оригинал: комната остаётся резкой, меняется только пол
async function blendIntoOriginal(original, maskBuffer, forgeBuffer) {

    const W = original.info.width;
    const H = original.info.height;

    const alpha = await sharp(maskBuffer)
        .resize(W, H, { fit: "fill" })
        .greyscale()
        .threshold(128)
        .blur(3)
        .toColourspace("b-w")
        .raw()
        .toBuffer({ resolveWithObject: true });

    let floorRgb = await sharp(forgeBuffer)
        .resize(W, H, { fit: "fill", kernel: "lanczos3" })
        .removeAlpha()
        .png()
        .toBuffer();

    if (BLEND_MODE === "light") {
        floorRgb = await transferLighting(original.data, floorRgb, W, H);
    } else if (BLEND_MODE === "hybrid") {
        floorRgb = await hybridFloor(original.data, floorRgb, alpha.data, W, H);
    } else {
        floorRgb = await sharp(floorRgb).sharpen({ sigma: 0.8 }).png().toBuffer();
    }

    const floorLayer = await sharp(floorRgb)
        .joinChannel(alpha.data, {
            raw: { width: W, height: H, channels: 1 }
        })
        .png()
        .toBuffer();

    return sharp(original.data)
        .removeAlpha()
        .composite([{ input: floorLayer }])
        .png()
        .toBuffer();
}

function forgeHeaders() {
    const headers = {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "1"
    };

    if (FORGE_AUTH) {
        headers["Authorization"] =
            "Basic " + Buffer.from(FORGE_AUTH).toString("base64");
    }

    return headers;
}

// Один запрос к Forge, возвращает картинку (Buffer)
async function forgeImg2Img(payload) {

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORGE_TIMEOUT_MS);

    let response;
    let text;

    try {
        response = await fetch(FORGE_URL + "/sdapi/v1/img2img", {
            method: "POST",
            headers: forgeHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        text = await response.text();

    } catch (e) {
        if (e.name === "AbortError") {
            throw new Error("Forge не ответил за " + Math.round(FORGE_TIMEOUT_MS / 1000) + " сек");
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(
            "Forge ошибка " + response.status + ": " + text.slice(0, 500)
        );
    }

    let data;

    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error("Forge вернул не JSON: " + text.slice(0, 200));
    }

    if (!data.images || !data.images[0]) {
        throw new Error("Forge не вернул изображение");
    }

    return Buffer.from(data.images[0], "base64");
}

// Описание для ИИ: реализм + описание конкретного ламината
function buildFloorPrompt(laminate) {
    return (
        "RAW photo of a real room interior, " +
        describeFloor(laminate) +
        ", individual planks with subtle natural tone variation, thin dark beveled seams between planks, " +
        "realistic wood grain, soft natural daylight, gentle reflections of window light on the floor, " +
        "realistic perspective, soft contact shadows along the walls, sharp focus, high detail, photorealistic"
    );
}

async function inpaintWithForge(roomBuffer, maskBuffer, prompt, denoiseOverride) {

    const { roomPng, maskPng, width, height, original } =
        await prepareForForge(roomBuffer, maskBuffer);

    const isFlux = FORGE_MODEL === "flux";
    const isRefine = typeof denoiseOverride === "number";

    const payload = {
        init_images: [roomPng.toString("base64")],
        mask: maskPng.toString("base64"),
        prompt: prompt,
        negative_prompt: isFlux ? "" : FORGE_NEGATIVE,
        width: width,
        height: height,
        steps: FORGE_STEPS,
        cfg_scale: isFlux ? 1 : FORGE_CFG,
        sampler_name: isFlux ? "Euler" : "DPM++ 2M",
        scheduler: isFlux ? "Simple" : "Karras",
        denoising_strength: isRefine
            ? denoiseOverride
            : parseFloat(process.env.FORGE_DENOISE || "0.95"),
        inpainting_fill: 1,
        inpaint_full_res: FORGE_FULL_RES,
        inpaint_full_res_padding: 64,
        inpainting_mask_invert: 0,
        mask_blur: 4,
        batch_size: 1,
        n_iter: 1
    };

    if (isFlux) {
        payload.distilled_cfg_scale = 3.5;
    }

    if (FORGE_CHECKPOINT) {
        payload.override_settings = { sd_model_checkpoint: FORGE_CHECKPOINT };
    }

    // Проход 1: ИИ перерисовывает пол
    let forgeBuffer = await forgeImg2Img(payload);

    // Проход 2 (необязательно): мягкая доводка для чёткости
    if (isRefine && FORGE_PASSES >= 2) {
        try {
            forgeBuffer = await forgeImg2Img(Object.assign({}, payload, {
                init_images: [forgeBuffer.toString("base64")],
                denoising_strength: FORGE_PASS2_DENOISE
            }));
        } catch (e) {
            console.warn("Второй проход Forge не удался, оставляем первый:", e.message);
        }
    }

    try {
        return await blendIntoOriginal(original, maskBuffer, forgeBuffer);
    } catch (e) {
        console.error("Не удалось вставить пол в оригинал, отдаём результат Forge как есть:", e.message);
        return forgeBuffer;
    }
}

// ==========================================
// Визуализация
// ==========================================

const uploadFields = upload.fields([
    { name: "room", maxCount: 1 },
    { name: "mask", maxCount: 1 }
]);

app.post("/visualize", rateLimit, uploadFields, async (req, res) => {

    console.log("");
    console.log("=================================");
    console.log("Получен запрос на визуализацию");
    console.log("=================================");

    console.log("Ламинат:", req.body.laminate);
    console.log("Плинтус:", req.body.skirting);

    const roomFile = req.files && req.files.room && req.files.room[0];
    const maskFile = req.files && req.files.mask && req.files.mask[0];

    if (!roomFile) {
        console.log("Файл НЕ получен");
        return res.status(400).json({ error: "Фото не получено" });
    }

    console.log("Файл сохранён:", roomFile.filename);
    console.log("Маска:", maskFile ? maskFile.filename : "нет");

    if (USE_FORGE && maskFile && pending >= MAX_PENDING) {
        [roomFile, maskFile].forEach(f => { if (f) fs.unlink(f.path, () => {}); });
        return res.status(503).json({ error: "Сервер занят, попробуйте через минуту" });
    }

    try {

        const imageBuffer = fs.readFileSync(roomFile.path);

        const laminate = req.body.laminate || "выбранный ламинат";
        const skirting = req.body.skirting || "выбранный плинтус";

        let finalImageBuffer;

        const isRefine = req.body.mode === "refine";

        if (isRefine && !(USE_FORGE && maskFile)) {
            return res.status(503).json({ error: "ИИ-улучшение сейчас недоступно" });
        }

        if (USE_FORGE && maskFile) {

            // ---------- Путь Forge: только пол, по маске ----------

            console.log("Меняем пол через Forge...");

            const maskBuffer = fs.readFileSync(maskFile.path);

            // Сила ИИ приходит с сайта (ползунок), ограничиваем разумными пределами
            let refineDenoise = parseFloat(req.body.denoise);
            refineDenoise = isFinite(refineDenoise)
                ? Math.min(0.75, Math.max(0.2, refineDenoise))
                : FORGE_REFINE_DENOISE;

            const floorPrompt = buildFloorPrompt(laminate);

            console.log("Режим:", isRefine ? "улучшение реализма (сила " + refineDenoise + ", вклейка " + BLEND_MODE + ")" : "полная замена");
            console.log("Промпт:", floorPrompt);

            finalImageBuffer = await runExclusive(() =>
                inpaintWithForge(
                    imageBuffer,
                    maskBuffer,
                    floorPrompt,
                    isRefine ? refineDenoise : undefined
                )
            );

            console.log("Forge готов (плинтус пока не меняется).");

        } else {

            // ---------- Путь Gemini (как раньше) ----------

            console.log("Шаг 1: меняем пол через Gemini...");

            const floorPrompt = `Replace the floor with realistic ${laminate} laminate flooring. Keep everything else in the room exactly the same, photorealistic, same camera angle.`;

            const floorImageBuffer = await editImageWithGemini(
                imageBuffer,
                roomFile.mimetype,
                floorPrompt
            );

            console.log("Шаг 1 готов.");

            console.log("Шаг 2: меняем плинтус через Gemini...");

            const skirtingPrompt = `Replace the wall baseboards (skirting boards) at the bottom of the walls with clearly visible ${skirting} colored skirting boards. Keep everything else exactly the same, photorealistic, same camera angle.`;

            finalImageBuffer = await editImageWithGemini(
                floorImageBuffer,
                "image/png",
                skirtingPrompt
            );

            console.log("Шаг 2 готов.");
        }

        const resultFileName = "result-" + crypto.randomBytes(12).toString("hex") + ".png";
        const resultPath = path.join("uploads", resultFileName);

        fs.writeFileSync(resultPath, finalImageBuffer);

        console.log("Результат сохранён:", resultFileName);

        res.json({
            message: "Готово",
            resultFile: resultFileName,
            resultUrl: `${PUBLIC_URL}/uploads/${resultFileName}`
        });

    } catch (error) {

        console.error("");
        console.error("=================================");
        console.error("ОШИБКА AI");
        console.error("=================================");
        console.error(error);

        res.status(500).json({
            error: "Ошибка AI сервиса",
            details: error.message
        });

    } finally {
        // исходные фото клиента не храним
        [roomFile, maskFile].forEach(f => { if (f) fs.unlink(f.path, () => {}); });
    }
});

console.log(
    "=== StroyCity Visualizer — " +
        (USE_FORGE ? "Forge + Gemini" : "Gemini") +
        " ==="
);

app.listen(PORT, () => {
    console.log(`Server запущен на порту ${PORT}`);
});
