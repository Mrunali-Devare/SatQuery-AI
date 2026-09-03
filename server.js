const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const sharp = require("sharp");

// Load environment variables from .env
dotenv.config();

const app = express();

// Configuration constants
const PORT = Number(process.env.PORT || 3000);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "dots-studio/dots-3-note-preview:free";

console.log("=================================");
console.log("       SATQUERY AI SERVER");
console.log("=================================");
console.log("Model:", MODEL);
console.log("Port:", PORT);

// =====================================================
// STATIC ASSETS & MIDDLEWARE
// =====================================================

// Serve static frontend files from /public
app.use(express.static("public"));

// =====================================================
// MULTER FILE UPLOAD CONFIGURATION
// =====================================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024 // 100 MB upload limit
    },
    fileFilter: (req, file, callback) => {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

        if (allowedTypes.includes(file.mimetype)) {
            callback(null, true);
        } else {
            callback(new Error("Only JPG, PNG and WEBP images are allowed."));
        }
    }
});

// =====================================================
// QUESTION CLASSIFICATION & INTENT MAPPING
// =====================================================

/**
 * Classifies user questions into predefined categories using keyword regex.
 * @param {string} question
 * @returns {string} Task category
 */
function classifyQuestion(question) {
    const q = question.toLowerCase();

    if (/\b(how many|number of|count|counting|total)\b/.test(q)) {
        return "counting";
    }
    if (/\b(where|location|position|left|right|north|south|east|west|near|beside|between|center|corner)\b/.test(q)) {
        return "spatial";
    }
    if (/\b(area|percentage|proportion|coverage|extent|size)\b/.test(q)) {
        return "measurement";
    }
    if (/\b(water|river|lake|pond|reservoir|sea|coast|wetland)\b/.test(q)) {
        return "water";
    }
    if (/\b(crop|farmland|agriculture|agricultural|field|vegetation|forest|tree|plant)\b/.test(q)) {
        return "vegetation";
    }
    if (/\b(building|road|highway|street|bridge|urban|city|house|structure)\b/.test(q)) {
        return "infrastructure";
    }
    if (/\b(vehicle|car|truck|bus|train|aircraft|ship|boat)\b/.test(q)) {
        return "object";
    }
    if (/\b(compare|difference|changed|change|before|after|previous|earlier)\b/.test(q)) {
        return "change_detection";
    }

    return "general";
}

/**
 * Determines whether the response should be concise (short) or detailed.
 * @param {string} question
 * @returns {"detailed" | "short"}
 */
function getAnswerStyle(question) {
    const q = question.toLowerCase().trim();

    // Explicitly descriptive questions
    const descriptiveWords = /\b(describe|description|explain|explanation|detailed|detail|analyze|analysis|characteristics|observations|discuss|compare|comparison)\b/;
    if (descriptiveWords.test(q)) {
        return "detailed";
    }

    // Simple yes/no or presence questions
    const simplePatterns = [
        /^(is|are|does|do|can|has|have)\b/,
        /\bvisible\b/,
        /\bpresent\b/
    ];
    if (simplePatterns.some((pattern) => pattern.test(q))) {
        return "short";
    }

    // Simple location questions
    if (/\bwhere\b/.test(q)) {
        return "short";
    }

    // Simple counting questions
    if (/\b(how many|number of|count)\b/.test(q)) {
        return "short";
    }

    return "short";
}

// =====================================================
// SYSTEM PROMPTS & INSTRUCTION BUILDERS
// =====================================================

/**
 * Builds the base system prompt enforcing satellite reasoning constraints.
 * @param {string} taskType
 * @returns {string}
 */
function createSystemPrompt(taskType) {
    return `
You are SatQuery AI, a satellite-image visual question answering assistant.

Answer the user's question using only visible evidence from the supplied image.

TASK TYPE:
${taskType}

RULES:

1. Do not invent information.
2. Do not identify people.
3. Do not claim exact measurements without sufficient evidence.
4. If something is unclear, state that briefly.
5. For counting, give an approximate count only when objects are distinguishable.
6. For spatial questions, use image-relative positions such as left, right, center, upper-left or lower-right.
7. Answer only what the user asked.
8. Never provide a full image description unless the user explicitly asks for one.
9. Never create "Directly Visible Observations" or "Interpretations" unless explicitly requested.

Do not include your reasoning in the answer.
Return only the final answer.
`.trim();
}

/**
 * Provides task-specific instructions tailored to the classified query.
 * @param {string} taskType
 * @returns {string}
 */
function createTaskInstruction(taskType) {
    const instructions = {
        general: `
Answer the user's question directly using only visible evidence.
`,
        counting: `
Determine whether individual objects are sufficiently visible to count.

If they are clearly distinguishable:
provide an approximate count briefly.

If they overlap, are too small, or are ambiguous:
state briefly that a reliable exact count is not possible.
`,
        spatial: `
Describe the spatial relationship using image-relative positions.

Use terms such as:
upper-left, upper-right, center, lower-left,
lower-right, left side, right side, top, bottom.
`,
        measurement: `
Be conservative with measurements.

Do not infer exact real-world area, distance or percentage
without sufficient scale/geospatial information.

If only visual comparison is possible, describe it qualitatively.
`,
        water: `
Determine whether a water body is visible.
Use only evidence necessary to answer the user's question.
`,
        vegetation: `
Determine whether vegetation or agricultural areas are visible.
Use only evidence necessary to answer the user's question.
`,
        infrastructure: `
Determine whether relevant human-made structures are visible.
Use only evidence necessary to answer the user's question.
`,
        object: `
Look for individually distinguishable objects.

Only count or classify objects when their visual size and
separation make the conclusion reasonably reliable.
`,
        change_detection: `
A true before/after change analysis requires two comparable images.

If only one image is supplied, explicitly state that temporal
change cannot be established from one image alone.
`
    };

    return instructions[taskType] || instructions.general;
}

// =====================================================
// IMAGE RESIZING & OPTIMIZATION PIPELINE
// =====================================================

/**
 * Resolves optimal pixel resolution based on task complexity and answer depth.
 * @param {string} taskType
 * @param {"short" | "detailed"} answerStyle
 * @returns {number} Target dimension in pixels
 */
function getProcessingSize(taskType, answerStyle) {
    if (answerStyle === "short") {
        return 1536;
    }

    if (answerStyle === "detailed") {
        switch (taskType) {
            case "counting":
            case "object":
            case "measurement":
                return 3072;

            case "spatial":
            case "infrastructure":
                return 2560;

            default:
                return 2048;
        }
    }

    return 1536;
}

/**
 * Resizes, auto-orients, and compresses input satellite images using Sharp.
 * @param {Buffer} buffer
 * @param {string} taskType
 * @param {"short" | "detailed"} answerStyle
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
async function processSatelliteImage(buffer, taskType, answerStyle) {
    const metadata = await sharp(buffer).metadata();

    console.log("Original dimensions:", metadata.width, "x", metadata.height);
    console.log("Original format:", metadata.format);
    console.log("Original size:", (buffer.length / 1024 / 1024).toFixed(2), "MB");

    const processingSize = getProcessingSize(taskType, answerStyle);
    console.log("Task type:", taskType);
    console.log("Processing size:", processingSize);

    // Resize bounding box to fit inside bounds while preserving aspect ratio
    const processed = await sharp(buffer)
        .rotate()
        .resize({
            width: processingSize,
            height: processingSize,
            fit: "inside",
            withoutEnlargement: true
        })
        .jpeg({
            quality: 82,
            mozjpeg: true
        })
        .toBuffer();

    const processedMetadata = await sharp(processed).metadata();

    console.log("Processed dimensions:", processedMetadata.width, "x", processedMetadata.height);
    console.log("Processed size:", (processed.length / 1024 / 1024).toFixed(2), "MB");

    return {
        buffer: processed,
        width: processedMetadata.width,
        height: processedMetadata.height
    };
}

// =====================================================
// OUTPUT SANITIZATION & OPENROUTER API CLIENT
// =====================================================

/**
 * Strips markdown styling, backticks, and extra whitespace from raw LLM output.
 * @param {string} text
 * @returns {string}
 */
function cleanAnswer(text) {
    if (!text) return "";

    let cleaned = text;

    // Remove Markdown bold / italic
    cleaned = cleaned.replace(/\*\*/g, "");
    cleaned = cleaned.replace(/__/g, "");
    cleaned = cleaned.replace(/\*/g, "");

    // Remove Markdown headings
    cleaned = cleaned.replace(/^#{1,6}\s*/gm, "");

    // Remove backticks
    cleaned = cleaned.replace(/`/g, "");

    // Remove Markdown bullets
    cleaned = cleaned.replace(/^\s*[-•]\s+/gm, "");

    // Remove Markdown links, keep visible text
    cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    // Clean spaces
    cleaned = cleaned.replace(/[ \t]+/g, " ");

    // Clean excessive empty lines
    cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, "\n\n");

    return cleaned.trim();
}

/**
 * Dispatches multimodal query to OpenRouter vision models with timeout controls.
 */
async function askVisionModel(imageDataUrl, question, taskType, imageWidth, imageHeight, answerStyle) {
    const systemPrompt = createSystemPrompt(taskType);
    const taskInstruction = createTaskInstruction(taskType);

    const answerStyleInstruction =
        answerStyle === "short"
            ? `
ANSWER STYLE: SHORT

Answer only the user's question.
Use exactly ONE sentence.
Use no more than 20 words.

For yes/no questions, start with Yes or No.

Return ONLY the final answer.
`
            : `
ANSWER STYLE: DETAILED

Provide a complete but focused answer.

Include relevant:
- visible observations
- location
- shape or appearance
- spatial relationships
- important uncertainty

Use 5–8 numbered points when appropriate.

Do not discuss unrelated features.
Do not invent information.
Complete the answer before stopping.

Return ONLY the final answer.
`;

    const prompt = `
${taskInstruction}

${answerStyleInstruction}

Image dimensions:
${imageWidth} × ${imageHeight}

User question:
${question}

Answer the user's question using the supplied satellite image.

Return ONLY the final answer.
`.trim();

    console.log("Calling OpenRouter...");
    console.log("Task:", taskType);
    console.log("Model:", MODEL);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000); // 90-second timeout

    try {
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "SatQuery AI"
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: prompt
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: imageDataUrl
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.1,
                max_tokens: answerStyle === "short" ? 400 : 1800
            })
        });

        const raw = await response.text();

        console.log("OpenRouter HTTP:", response.status);
        console.log("========== OPENROUTER RESPONSE ==========");
        console.log(raw);
        console.log("==========================================");

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error("OpenRouter returned an invalid response.");
        }

        if (!response.ok) {
            throw new Error(data.error?.message || `OpenRouter request failed (${response.status}).`);
        }

        const message = data?.choices?.[0]?.message;
        const answer = message?.content;

        console.log("Model message:", message);
        console.log("Model content:", answer);
        console.log("Finish reason:", data?.choices?.[0]?.finish_reason);
        console.log("Has final content:", Boolean(answer));

        if (!answer) {
            throw new Error("The vision model did not return a final answer.");
        }

        return {
            answer: cleanAnswer(answer),
            usage: data.usage || null
        };
    } finally {
        clearTimeout(timeout);
    }
}

// =====================================================
// MAIN API ENDPOINTS
// =====================================================

app.post("/ask", upload.single("image"), async (req, res) => {
    const startTime = Date.now();

    try {
        console.log("\n=================================");
        console.log("NEW SATQUERY REQUEST");
        console.log("=================================");

        // 1. API Key Validation
        if (!process.env.OPENROUTER_API_KEY) {
            return res.status(500).json({
                error: "OpenRouter API key is missing."
            });
        }

        // 2. Image Validation
        if (!req.file) {
            return res.status(400).json({
                error: "Satellite image is required."
            });
        }

        // 3. Question Validation
        const question = req.body.question?.trim();
        if (!question) {
            return res.status(400).json({
                error: "Question is required."
            });
        }

        if (question.length > 1000) {
            return res.status(400).json({
                error: "Question is too long."
            });
        }

        console.log("Question:", question);
        console.log("File:", req.file.originalname);

        // 4. Classify Intent & Style
        const taskType = classifyQuestion(question);
        const answerStyle = getAnswerStyle(question);

        console.log("Task type:", taskType);
        console.log("Answer style:", answerStyle);

        // 5. Image Processing
        const processed = await processSatelliteImage(req.file.buffer, taskType, answerStyle);
        const base64Image = processed.buffer.toString("base64");
        const imageDataUrl = `data:image/jpeg;base64,${base64Image}`;

        // 6. Model Query Execution
        const result = await askVisionModel(
            imageDataUrl,
            question,
            taskType,
            processed.width,
            processed.height,
            answerStyle
        );

        // 7. Success Response
        const processingTime = Date.now() - startTime;
        console.log("Processing time:", processingTime, "ms");

        res.json({
            success: true,
            answer: result.answer,
            taskType: taskType,
            image: {
                width: processed.width,
                height: processed.height
            },
            processingTimeMs: processingTime,
            usage: result.usage
        });
    } catch (error) {
        console.error("SATQUERY ERROR:", error);

        if (error.name === "AbortError") {
            return res.status(504).json({
                error: "The AI model took too long to respond. Please try again."
            });
        }

        res.status(500).json({
            error: error.message || "Unexpected server error."
        });
    }
});

// =====================================================
// GLOBAL & MULTER ERROR HANDLING MIDDLEWARE
// =====================================================

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "Image is too large. Maximum allowed size is 100 MB."
            });
        }
        return res.status(400).json({
            error: err.message
        });
    }

    if (err) {
        return res.status(400).json({
            error: err.message
        });
    }

    next();
});

// =====================================================
// SERVER INITIALIZATION
// =====================================================

app.listen(PORT, () => {
    console.log(`SatQuery running at http://localhost:${PORT}`);
});