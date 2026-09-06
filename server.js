const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const sharp = require("sharp");
dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENROUTER_URL ="https://openrouter.ai/api/v1/chat/completions";
const MODEL =process.env.OPENROUTER_MODEL ||"dots-studio/dots-3-note-preview:free";

console.log("=================================");
console.log("       SATQUERY AI SERVER");
console.log("=================================");
console.log("Model:", MODEL);
console.log("Port:", PORT);

// =====================================================
// SERVE FRONTEND
// =====================================================

app.use(express.static("public"));

// =====================================================
// IMAGE UPLOAD
// =====================================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        // 100 MB upload limit
        fileSize: 100 * 1024 * 1024
    },
    fileFilter: (req, file, callback) => {
        const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff"
];
        if (allowedTypes.includes(file.mimetype)) {
            callback(null, true);
        } else {
            callback(
    new Error("Only JPG, PNG, WEBP and TIFF images are allowed.")
);
        }
    }
});

// =====================================================
// QUESTION CLASSIFICATION
// =====================================================

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
    return "general";
}

// =====================================================
// SATELLITE-SPECIFIC SYSTEM PROMPT
// =====================================================

function createSystemPrompt(taskType) {
    return `
You are SatQuery AI, a remote-sensing single-image Visual Question Answering assistant.
You are given exactly ONE satellite or remote-sensing image and one user question.
Answer ONLY from visible evidence in the supplied image.
TASK:${taskType}

IMPORTANT RULES:
1. Do not invent facts.
2. Do not use outside geographic knowledge.
3. Do not invent coordinates, dates, sensor names, CRS, resolution, area, percentages, object counts, or other metadata unless visible/provided.
4. If the image does not provide sufficient evidence, say that clearly.
5. Use remote-sensing terminology when appropriate: water, vegetation, agriculture, built-up, road, bare soil, forest, etc.
6. For spatial questions use image-relative positions:upper-left, upper-right, center, lower-left, lower-right,left, right, top, bottom.
7. Do not provide a full scene description unless requested.
8. For counting, only estimate when individual objects are distinguishable.
9. For measurements, be conservative unless actual scale is available.
10. Never expose internal reasoning.
11. For questions asking WHERE a visible object or feature is located,provide an approximate bounding box when the object is visuallydistinguishable.
12. Bounding box coordinates must be normalized from 0 to 1:x = left position,y = top position,width = box width,height = box height.
13. If the requested feature cannot be reliably localized,set grounding.available to false.
14. Do not create a grounding box merely because the user asks for one. Only provide it when the feature is visibly distinguishable.
Return ONLY valid JSON:
{
  "answer": "final answer",
  "confidence": 0.0,
  "evidence": "short visual evidence supporting the answer",
  "caveat": "short limitation or uncertainty statement",
  "grounding": {
    "available": false,
    "label": "",
    "x": 0,
    "y": 0,
    "width": 0,
    "height": 0
  }
}
`.trim();
}

// =====================================================
// TASK-SPECIFIC INSTRUCTIONS
// =====================================================

function createTaskInstruction(taskType) {
    const instructions = {
        general: `Answer the user's question directly using only visible evidence.`,
        counting: `Determine whether individual objects are sufficiently visible to count.
If they are clearly distinguishable:
provide an approximate count briefly.
If they overlap, are too small, or are ambiguous:
state briefly that a reliable exact count is not possible.`,
        spatial: `Describe the spatial relationship using image-relative positions.
Use terms such as:
upper-left, upper-right, center, lower-left,lower-right, left side, right side, top, bottom.
If the requested feature is clearly visible,also provide an approximate visual grounding bounding box.
The bounding box must use normalized coordinates from 0 to 1:
x = left
y = top
width = box width
height = box height
If the feature cannot be reliably localized,
set grounding.available to false.`,
        measurement: `Be conservative with measurements.
Do not infer exact real-world area, distance or percentage without sufficient scale/geospatial information.
If only visual comparison is possible, describe it qualitatively.`,
        water: `Determine whether a water body is visible. Use only evidence necessary to answer the user's question.`,
        vegetation:`Determine whether vegetation or agricultural areas are visible.Use only evidence necessary to answer the user's question.`,
        infrastructure: `Determine whether relevant human-made structures are visible.Use only evidence necessary to answer the user's question.`,
        object: `Look for individually distinguishable objects.Only count or classify objects when their visual size andseparation make the conclusion reasonably reliable.`,
        change_detection:`A true before/after change analysis requires two comparable images.If only one image is supplied, explicitly state that temporal change cannot be established from one image alone.`
    };
    return instructions[taskType] || instructions.general;
}
function getImageProcessingSize(taskType, answerStyle) {
  // Fast path for simple VQA questions
  if (answerStyle === 'short') {
    return 1280;
  }
  // Keep more detail for tasks that depend on visual detail
  if (['counting', 'object'].includes(taskType)) {
    return 2048;
  }
  if (['spatial', 'infrastructure', 'measurement'].includes(taskType)) {
    return 2048;
  }
  return 1536;
}

// =====================================================
// IMAGE PROCESSING
// =====================================================

async function processSatelliteImage(buffer, taskType, answerStyle) {
    const metadata =await sharp(buffer).metadata();
    console.log("Original dimensions:",metadata.width,"x",metadata.height);
    console.log("Original format:",metadata.format);
    console.log("Original size:",(buffer.length / 1024 / 1024).toFixed(2),"MB");
    /* Keep more detail than a small thumbnail, but avoid sending unnecessarily huge images.*/
    const size = getImageProcessingSize(taskType, answerStyle);
    console.log("Task type:", taskType);
    console.log("Processing size:", size);
    const processed =await sharp(buffer).rotate().resize({
                width: size,
                height: size,
                fit: "inside",
                withoutEnlargement: true
            })
            .jpeg({
                quality: 82,
                mozjpeg: true
            })
            .toBuffer();

    const processedMetadata =await sharp(processed).metadata();
    console.log("Processed dimensions:",processedMetadata.width,"x",processedMetadata.height);
    console.log("Processed size:",(processed.length / 1024 / 1024).toFixed(2),"MB");
    return {
    buffer: processed,
    width:processedMetadata.width,
    height:processedMetadata.height,
    originalWidth:metadata.width || null,
    originalHeight:metadata.height || null,
    format:metadata.format || null,
    bands:metadata.channels ||null,
    space:metadata.space || null,
    depth:metadata.depth || null,
    hasAlpha:Boolean(metadata.hasAlpha),
    density:metadata.density || null,
    chromaSubsampling:metadata.chromaSubsampling || null
};
}

async function analyzeImageQuality(buffer) {
    try {
        const stats =await sharp(buffer).greyscale().stats();
        const channel =stats.channels?.[0];
        if (!channel) {
            return {
                label: "UNKNOWN",
                score: 0.5
            };
        }
        const mean =channel.mean || 0;
        const stddev =channel.stdev || 0;
        let score = 0.75;

        // Very flat image
        if (stddev < 10) {
            score -= 0.35;
        }
        // Extremely dark / bright
        if (mean < 15 || mean > 245) {
            score -= 0.2;
        }
        score =Math.max(0,Math.min(1, score));
        let label = "GOOD";
        if (score < 0.45) {
            label = "LOW";
        } else if (score < 0.7) {
            label = "FAIR";
        }
        return {
            label,
            score
        };
    } catch {
        return {
            label: "UNKNOWN",
            score: 0.5
        };
    }
}

function isUnsupportedSingleImageQuestion(question) {
    const q =question.toLowerCase().trim();
    return /\b(what changed|change from|changed since|before and after|compared with|compared to|previous date|earlier date|last year|this year versus|between two dates)\b/.test(q);
}

// =====================================================
// OPENROUTER CALL
// =====================================================

function cleanAnswer(text) {
    if (!text) return "";
    let cleaned = text;
    cleaned =cleaned.replace(/\*\*(.*?)\*\*/g,"$1")
    cleaned =cleaned.replace(/__(.*?)__/g,"$1");
    cleaned =cleaned.replace(/^#{1,6}\s*/gm,"");
    cleaned =cleaned.replace(/`/g,"");
    cleaned =cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g,"$1");
    cleaned =cleaned.replace(/[ \t]+/g," ");
    cleaned =cleaned.replace(/\n{3,}/g,"\n\n");
    return cleaned.trim();
}

function getAnswerStyle(question) {
    const q =question.toLowerCase().trim();
    const detailedPattern =/\b(describe|description|explain|explanation|analyze|analysis|detailed|detail|characteristics|observations|discuss|summarize|summary)\b/;
    return detailedPattern.test(q)
        ? "detailed"
        : "short";
}

function parseModelResponse(text) {
  if (!text) {
    throw new Error('The vision model returned an empty response.');
  }

  let cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  // First: try to parse the complete response
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (_) {
    // Continue to JSON extraction below
  }

  // Second: try to extract a JSON object from surrounding text
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const jsonText = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (_) {
      // Continue to plain-text fallback
    }
  }
  // Last resort: treat the response as plain text.
  // IMPORTANT: never expose a JSON-looking response directly.
  if (/^\s*\{[\s\S]*\}\s*$/.test(cleaned)) {
    throw new Error(
      'The vision model returned an invalid structured response. Please try again.'
    );
  }
  return {
    answer: cleanAnswer(cleaned),
    confidence: 0.5,
    grounding: { available: false }
  };
}
function normalizeGrounding(grounding) {
    if (!grounding || typeof grounding !== "object") {
        return {
            available: false
        };
    }

    const width = Number(grounding.width);
    const height = Number(grounding.height);
    const x = Number(grounding.x);
    const y = Number(grounding.y);

    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return {
            available: false
        };
    }

    return {
        available: true,
        x: Number.isFinite(x) ? Math.max(0, Math.min(x, width)) : 0,
        y: Number.isFinite(y) ? Math.max(0, Math.min(y, height)) : 0,
        width: width,
        height: height,
        label: typeof grounding.label === "string"
            ? grounding.label
            : ""
    };
}
console.log("normalizeGrounding available:", typeof normalizeGrounding);
async function askVisionModel(
    imageDataUrl,
    question,
    taskType,
    width,
    height,
    answerStyle
) {
    const isSpatial = taskType === "spatial";

    const taskInstruction = createTaskInstruction(taskType);

    const prompt = `
You are performing single-image satellite Visual Question Answering.

Task:
${taskInstruction}

User question:
${question}

Image dimensions:
${width} × ${height}

Answer ONLY from the supplied satellite image.

Do not use outside geographic knowledge.
Do not invent facts, coordinates, dates, measurements, metadata, or object counts.

${isSpatial
    ? `If the requested feature is clearly visible, provide an approximate normalized bounding box.
All coordinates must be between 0 and 1.`
    : `Do not provide a bounding box.`}
`.trim();

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 45000);

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
                        content: `
You are SatQuery AI.

You are a satellite-image Visual Question Answering assistant.

You receive exactly one satellite image and one question.

Answer only from visible evidence in the supplied image.
Do not use outside geographic knowledge.
Do not invent information.

Return only the requested structured answer.
Do not output reasoning.
`.trim()
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

                max_tokens: answerStyle === "short"
                    ? 500
                    : 1000,

                reasoning: {
                    effort: "none"
                },

                response_format: {
                    type: "json_schema",

                    json_schema: {
                        name: "satquery_answer",

                        strict: true,

                        schema: {
                            type: "object",

                            properties: {
                                answer: {
                                    type: "string"
                                },

                                confidence: {
                                    type: "number"
                                },

                                grounding: {
                                    type: "object",

                                    properties: {
                                        available: {
                                            type: "boolean"
                                        },

                                        label: {
                                            type: "string"
                                        },

                                        x: {
                                            type: "number"
                                        },

                                        y: {
                                            type: "number"
                                        },

                                        width: {
                                            type: "number"
                                        },

                                        height: {
                                            type: "number"
                                        }
                                    },

                                    required: [
                                        "available",
                                        "label",
                                        "x",
                                        "y",
                                        "width",
                                        "height"
                                    ],

                                    additionalProperties: false
                                }
                            },

                            required: [
                                "answer",
                                "confidence",
                                "grounding"
                            ],

                            additionalProperties: false
                        }
                    }
                }
            })
        });

        const raw = await response.text();

        console.log("========== OPENROUTER RESPONSE ==========");
        console.log(raw);
        console.log("==========================================");

        let data;

        try {
            data = JSON.parse(raw);
        } catch (_) {
            throw new Error(
                "OpenRouter returned an invalid response."
            );
        }

        if (!response.ok) {
            throw new Error(
                data.error?.message ||
                `OpenRouter request failed (${response.status}).`
            );
        }

        const choice = data?.choices?.[0];

        if (!choice) {
            throw new Error(
                "OpenRouter returned no choices."
            );
        }

        const message = choice?.message;

        let content = message?.content;

        /*
         * Some providers can return content as an array.
         */
        if (Array.isArray(content)) {
            content = content
                .map(part => {
                    if (typeof part === "string") {
                        return part;
                    }

                    return part?.text || "";
                })
                .join("")
                .trim();
        }

        if (!content || !String(content).trim()) {
            console.log(
                "OpenRouter message:",
                JSON.stringify(message, null, 2)
            );

            throw new Error(
                "The vision model returned no final answer."
            );
        }

        const parsed = parseModelResponse(content);

        if (
            !parsed.answer ||
            typeof parsed.answer !== "string"
        ) {
            throw new Error(
                "The vision model did not return a usable answer."
            );
        }

        const confidence = Number(parsed.confidence);

        const grounding =
            parsed.grounding &&
            parsed.grounding.available === true
                ? normalizeGrounding(parsed.grounding)
                : {
                    available: false,
                    label: "",
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0
                };

        return {
            answer: cleanAnswer(parsed.answer),

            confidence:
                Number.isFinite(confidence)
                    ? Math.max(
                        0,
                        Math.min(1, confidence)
                    )
                    : 0.5,

            grounding,

            usage: data.usage || null
        };

    } catch (error) {

        if (error.name === "AbortError") {
            throw new Error(
                "The AI model took too long to respond. Please try again."
            );
        }

        throw error;

    } finally {
        clearTimeout(timeout);
    }
}

app.post("/preview", upload.single("image"), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                        error: "Image is required."
                    });
            }
            const preview =await sharp(req.file.buffer).rotate()
                    .resize({
                        width: 1600,
                        height: 1600,
                        fit: "inside",
                        withoutEnlargement: true
                    })
                    .jpeg({
                        quality: 88,
                        mozjpeg: true
                    })
                    .toBuffer();
            res.set(
                "Content-Type",
                "image/jpeg"
            );
            res.send(preview);
        } catch (error) {
            console.error("PREVIEW ERROR:",error);
            res.status(400).json({
                    error:"Unable to read this satellite image."
                });
        }
    }
);

// =====================================================
// MAIN /ASK ENDPOINT
// =====================================================

app.post(
    "/ask",
    upload.single("image"),
    async (req, res) => {
        const startTime =Date.now();
        try {
            console.log("\n=================================");
            console.log("NEW SATQUERY REQUEST");
            console.log("=================================");

            // -------------------------------
            // API KEY
            // -------------------------------

            if (!process.env.OPENROUTER_API_KEY) {
                return res.status(500).json({error:"OpenRouter API key is missing."});
            }

            // -------------------------------
            // IMAGE
            // -------------------------------

            if (!req.file) {
                return res.status(400).json({error:"Satellite image is required."});
            }

            // -------------------------------
            // QUESTION
            // -------------------------------

const question =req.body.question?.trim();

// -------------------------------
// EMPTY QUESTION
// -------------------------------

if (!question) {
    return res.status(400).json({error:"Question is required."});
}

// -------------------------------
// QUESTION LENGTH
// -------------------------------

if (question.length > 1000) {
    return res.status(400).json({error:"Question is too long."});
}

// -------------------------------
// SINGLE-IMAGE TEMPORAL CHECK
// -------------------------------

if (isUnsupportedSingleImageQuestion(question)) {
    return res.status(400).json({
            error:"Temporal change questions require two images. This interface supports Single-Image VQA only."
        });
}
            console.log("Question:",question);
            console.log("File:",req.file.originalname);

            // -------------------------------
            // CLASSIFY QUESTION
            // -------------------------------

            const taskType =classifyQuestion(question);
            const answerStyle =getAnswerStyle(question);
            console.log("Task type:", taskType);
            console.log("Answer style:", answerStyle);

            // -------------------------------
            // PROCESS IMAGE
            // -------------------------------

            const processed =await processSatelliteImage(req.file.buffer,taskType,answerStyle);
            const base64Image =processed.buffer.toString("base64");
            const imageDataUrl =`data:image/jpeg;base64,${base64Image}`;

            // -------------------------------
            // ASK MODEL
            // -------------------------------

            const result =await askVisionModel(
                    imageDataUrl,
                    question,
                    taskType,
                    processed.width,
                    processed.height,
                    answerStyle
                );

            // -------------------------------
            // RESPONSE
            // -------------------------------

            const processingTime =Date.now() - startTime;
            console.log("Processing time:",processingTime,"ms");
const imageQuality =await analyzeImageQuality(req.file.buffer);
const finalConfidence =Math.max(0,Math.min(1,(0.70 * result.confidence) +(0.30 * imageQuality.score)));
res.json({
    success: true,
    task: "SINGLE_VQA",
    questionType:taskType,
    answerStyle:answerStyle,
    answer:result.answer,
    confidence:finalConfidence,
    confidenceLabel:finalConfidence >= 0.80 ? "High" : finalConfidence >= 0.55 ? "Medium" : "Low",
    evidence:result.evidence,
    caveat:result.caveat ||"Confidence is a system estimate, not a guaranteed probability.",
    grounding:result.grounding || {
        available: false,
        label: "",
        x: 0,
        y: 0,
        width: 0,
        height: 0
    },
    imageQuality: {
        label:imageQuality.label,
        score:imageQuality.score
    },
    image: {
        width:processed.width,
        height:processed.height,
        originalWidth:processed.originalWidth,
        originalHeight:processed.originalHeight,
        format:processed.format,
        bands:processed.bands
    },
    model: {
        name:MODEL,
        provider:"OpenRouter"
    },
    execution: {
        steps: [{
                name: "Validate input",
                status: "ok"
            },
            {
                name: "Prepare image",
                status: "ok"
            },
            {
                name: "Run VQA model",
                status: "ok"
            },
            {
                name: "Compose response",
                status: "ok"
            }
        ]
    },
    processingTimeMs:processingTime,
    usage:result.usage
});
        } catch (error) {
            console.error(
                "SATQUERY ERROR:",
                error
            );
            if (
                error.name ===
                "AbortError"
            ) {
                return res.status(504).json({error:"The AI model took too long to respond. Please try again."});
            }
            res.status(500).json({error:error.message ||"Unexpected server error."});
        }
    }
);

// =====================================================
// MULTER / GENERAL ERROR HANDLING
// =====================================================

app.use((err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            if (err.code ==="LIMIT_FILE_SIZE") {
                return res.status(413).json({error:"Image is too large. Maximum allowed size is 100 MB."});
            }
            return res.status(400).json({error:err.message});
        }
        if (err) {
            return res.status(400).json({error:err.message});
        }
        next();
    }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT,() => {
        console.log(`SatQuery running at http://localhost:${PORT}`);
    }
);