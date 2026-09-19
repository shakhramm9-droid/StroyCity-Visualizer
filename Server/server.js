require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("ОШИБКА: GEMINI_API_KEY не найден в переменных окружения");
    process.exit(1);
}

// Создаём папку uploads
if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}

// Настройка загрузки файлов
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

const upload = multer({ storage });

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
    res.send("StroyCity Visualizer Server работает! (Gemini)");
});

// Вспомогательная функция: один запрос к Gemini
async function editImageWithGemini(imageBuffer, mimeType, prompt) {

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

// Визуализация
app.post("/visualize", upload.single("room"), async (req, res) => {

    console.log("");
    console.log("=================================");
    console.log("Получен запрос на визуализацию");
    console.log("=================================");

    console.log("Ламинат:", req.body.laminate);
    console.log("Плинтус:", req.body.skirting);

    if (!req.file) {
        console.log("Файл НЕ получен");
        return res.status(400).json({ error: "Фото не получено" });
    }

    console.log("Файл сохранён:", req.file.filename);

    try {

        const imageBuffer = fs.readFileSync(req.file.path);

        const laminate = req.body.laminate || "выбранный ламинат";
        const skirting = req.body.skirting || "выбранный плинтус";

        // ==========================================
        // Шаг 1: меняем ПОЛ
        // ==========================================

        console.log("Шаг 1: меняем пол через Gemini...");

        const floorPrompt = `Replace the floor with realistic ${laminate} laminate flooring. Keep everything else in the room exactly the same, photorealistic, same camera angle.`;

        const floorImageBuffer = await editImageWithGemini(
            imageBuffer,
            req.file.mimetype,
            floorPrompt
        );

        console.log("Шаг 1 готов.");

        // ==========================================
        // Шаг 2: меняем ПЛИНТУС на уже изменённом фото
        // ==========================================

        console.log("Шаг 2: меняем плинтус через Gemini...");

        const skirtingPrompt = `Replace the wall baseboards (skirting boards) at the bottom of the walls with clearly visible ${skirting} colored skirting boards. Keep everything else exactly the same, photorealistic, same camera angle.`;

        const finalImageBuffer = await editImageWithGemini(
            floorImageBuffer,
            "image/png",
            skirtingPrompt
        );

        console.log("Шаг 2 готов.");

        const resultFileName = "result-" + Date.now() + ".png";
        const resultPath = path.join("uploads", resultFileName);

        fs.writeFileSync(resultPath, finalImageBuffer);

        console.log("Результат сохранён:", resultFileName);

        res.json({
            message: "Готово",
            resultFile: resultFileName,
            resultUrl: `https://stroycity-visualizer-1.onrender.com/uploads/${resultFileName}`
        });

    } catch (error) {

        console.error("");
        console.error("=================================");
        console.error("ОШИБКА GEMINI");
        console.error("=================================");
        console.error(error);

        res.status(500).json({
            error: "Ошибка AI сервиса",
            details: error.message
        });
    }
});

console.log("=== StroyCity Visualizer — Gemini ===");

app.listen(PORT, () => {
    console.log(`Server запущен на порту ${PORT}`);
});
