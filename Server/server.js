require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { InferenceClient } = require("@huggingface/inference");

const app = express();
const PORT = 3000;

// Hugging Face
const HF_TOKEN = process.env.HF_TOKEN;

if (!HF_TOKEN) {
    console.error("ОШИБКА: HF_TOKEN не найден в .env");
    process.exit(1);
}

const hf = new InferenceClient(HF_TOKEN);

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

// Главная страница сервера
app.get("/", (req, res) => {
    res.send("StroyCity Visualizer Server работает!");
});

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

        return res.status(400).json({
            error: "Фото не получено"
        });
    }

    console.log("Файл сохранён:", req.file.filename);

    try {

        const imageBuffer = fs.readFileSync(req.file.path);

        const laminate = req.body.laminate || "выбранный ламинат";
        const skirting = req.body.skirting || "выбранный плинтус";

        // ==========================================
        // Шаг 1: меняем ПОЛ
        // ==========================================

        console.log("Шаг 1: отправляем фото в Hugging Face (пол)...");

        const floorPrompt = `Replace the floor with realistic ${laminate} laminate flooring. Keep everything else in the room exactly the same, photorealistic, same camera angle.`;

        const floorResult = await hf.imageToImage({
            model: "black-forest-labs/FLUX.1-Kontext-dev",
            inputs: new Blob([imageBuffer], { type: req.file.mimetype }),
            parameters: {
                prompt: floorPrompt,
                guidance_scale: 3.5,
                num_inference_steps: 30
            }
        });

        const floorImageBuffer = Buffer.from(await floorResult.arrayBuffer());

        console.log("Шаг 1 готов.");

        // ==========================================
        // Шаг 2: меняем ПЛИНТУС (на уже изменённом фото)
        // ==========================================

        console.log("Шаг 2: отправляем фото в Hugging Face (плинтус)...");

        const skirtingPrompt = `Replace the wall baseboards (skirting boards) at the bottom of the walls with clearly visible ${skirting} colored skirting boards. Keep everything else exactly the same, photorealistic, same camera angle.`;

        const finalResult = await hf.imageToImage({
            model: "black-forest-labs/FLUX.1-Kontext-dev",
            inputs: new Blob([floorImageBuffer], { type: "image/png" }),
            parameters: {
                prompt: skirtingPrompt,
                guidance_scale: 3.5,
                num_inference_steps: 30
            }
        });

        console.log("Шаг 2 готов. Hugging Face вернул итоговое изображение");

        const resultFileName = "result-" + Date.now() + ".png";
        const resultPath = path.join("uploads", resultFileName);

        fs.writeFileSync(resultPath, Buffer.from(await finalResult.arrayBuffer()));

        console.log("Результат сохранён:", resultFileName);

        res.json({
            message: "Готово",
            resultFile: resultFileName,
            resultUrl: `https://stroycity-visualizer-1.onrender.com/uploads/${resultFileName}`
        });

    } catch (error) {

        console.error("");
        console.error("=================================");
        console.error("ОШИБКА HUGGING FACE");
        console.error("=================================");
        console.error(error);

        res.status(500).json({
            error: "Ошибка AI сервиса",
            details: error.message
        });
    }
});

console.log("=== StroyCity Visualizer — Hugging Face ===");

app.listen(PORT, () => {
    console.log(`Server запущен: http://localhost:${PORT}`);
});
