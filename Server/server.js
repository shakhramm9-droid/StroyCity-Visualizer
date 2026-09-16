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

        const prompt = `
Edit this interior room photo.

Replace ONLY the existing floor with realistic laminate flooring:
"${laminate}"

Replace ONLY the visible floor skirting/baseboards with:
"${skirting}"

IMPORTANT:
- Keep the original room exactly the same.
- Keep walls unchanged.
- Keep furniture unchanged.
- Keep doors unchanged.
- Keep windows unchanged.
- Keep lighting and shadows natural.
- Keep the original camera angle and perspective.
- Do not add furniture.
- Do not remove furniture.
- Do not change the room layout.
- The new floor must follow the original perspective.
- The result must look like a real photograph of the same room after renovation.
`;

        console.log("Отправляем изображение в Hugging Face...");

        // Модель для редактирования изображений
        const result = await hf.imageToImage({
    model: "black-forest-labs/FLUX.1-Kontext-dev",
    inputs: new Blob([imageBuffer], { type: req.file.mimetype }),
    prompt: prompt
});

        console.log("Hugging Face вернул изображение");

        const resultFileName = "result-" + Date.now() + ".png";
        const resultPath = path.join("uploads", resultFileName);

        fs.writeFileSync(resultPath, Buffer.from(await result.arrayBuffer()));

        console.log("Результат сохранён:", resultFileName);

        res.json({
            message: "Готово",
            resultFile: resultFileName,
            resultUrl: `http://localhost:${PORT}/uploads/${resultFileName}`
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