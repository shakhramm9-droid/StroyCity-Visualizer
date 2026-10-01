require("dotenv").config();

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

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
const FORGE_MAX_SIDE = parseInt(process.env.FORGE_MAX_SIDE || "512", 10);
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
    "Дуб Виндзор": "oak laminate flooring, wood planks",
    "Дуб Бьерн": "oak laminate flooring, wood planks",
    "Дуб Пауэр": "oak laminate flooring, wood planks",
    "Дуб Кантри": "oak laminate flooring, wood planks",
    "Дуб Берлин": "oak laminate flooring, wood planks"
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

function runExclusive(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
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

    return { roomPng, maskPng, width, height };
}

async function inpaintWithForge(roomBuffer, maskBuffer, prompt) {

    const { roomPng, maskPng, width, height } =
        await prepareForForge(roomBuffer, maskBuffer);

    const payload = {
        init_images: [roomPng.toString("base64")],
        mask: maskPng.toString("base64"),
        prompt: prompt,
        negative_prompt: "",
        width: width,
        height: height,
        steps: 20,
        cfg_scale: 1,
        distilled_cfg_scale: 3.5,
        sampler_name: "Euler",
        scheduler: "Simple",
        denoising_strength: parseFloat(process.env.FORGE_DENOISE || "0.95"),
        inpainting_fill: 1,
        inpaint_full_res: false,
        inpainting_mask_invert: 0,
        mask_blur: 8,
        batch_size: 1,
        n_iter: 1
    };

    if (FORGE_CHECKPOINT) {
        payload.override_settings = { sd_model_checkpoint: FORGE_CHECKPOINT };
    }

    const headers = {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "1"
    };

    if (FORGE_AUTH) {
        headers["Authorization"] =
            "Basic " + Buffer.from(FORGE_AUTH).toString("base64");
    }

    const response = await fetch(FORGE_URL + "/sdapi/v1/img2img", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
    });

    const text = await response.text();

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

// ==========================================
// Визуализация
// ==========================================

const uploadFields = upload.fields([
    { name: "room", maxCount: 1 },
    { name: "mask", maxCount: 1 }
]);

app.post("/visualize", uploadFields, async (req, res) => {

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

    try {

        const imageBuffer = fs.readFileSync(roomFile.path);

        const laminate = req.body.laminate || "выбранный ламинат";
        const skirting = req.body.skirting || "выбранный плинтус";

        let finalImageBuffer;

        if (USE_FORGE && maskFile) {

            // ---------- Путь Forge: только пол, по маске ----------

            console.log("Меняем пол через Forge...");

            const maskBuffer = fs.readFileSync(maskFile.path);

            const floorPrompt =
                "photorealistic interior photograph, " +
                describeFloor(laminate) +
                ", natural daylight, realistic perspective and soft shadows";

            console.log("Промпт:", floorPrompt);

            finalImageBuffer = await runExclusive(() =>
                inpaintWithForge(imageBuffer, maskBuffer, floorPrompt)
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

        const resultFileName = "result-" + Date.now() + ".png";
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
