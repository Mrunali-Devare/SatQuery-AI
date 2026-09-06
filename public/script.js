const imageInput = document.getElementById("imageInput");
const preview = document.getElementById("preview");
const previewWrapper = document.getElementById("previewWrapper");
const uploadBox = document.getElementById("uploadBox");
const groundingCanvas = document.getElementById("groundingCanvas");
const groundingInfo = document.getElementById("groundingInfo");
const groundingContext = groundingCanvas.getContext("2d");
const questionInput = document.getElementById("question");
const askButton = document.getElementById("askButton");
const loading = document.getElementById("loading");
const answerSection = document.getElementById("answerSection");
const answerElement = document.getElementById("answer");
const errorSection = document.getElementById("errorSection");
const errorElement = document.getElementById("error");

// =====================================================
// FORMAT AI ANSWER
// =====================================================

function formatAnswer(text, answerStyle) {
    if (!text) return "";
    let cleaned = text
        .replace(/\*\*/g, "")
        .replace(/__/g, "")
        .replace(/`/g, "")
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Short/simple answer:
    if (answerStyle === "short") {
        return cleaned
            .replace(/\n+/g, " ")
            .trim();
    }

    // Descriptive answer:
    return cleaned;
}

function detectAnswerStyle(question) {
    const q = question.toLowerCase().trim();
    const descriptivePattern =
        /\b(describe|description|explain|explanation|analyze|analysis|detailed|detail|characteristics|observations|discuss|summarize|summary)\b/;

    if (descriptivePattern.test(q)) {
        return "detailed";
    }
    return "short";
}

// =====================================================
// VISUAL GROUNDING
// =====================================================

function drawGrounding(grounding) {

    // Clear previous grounding
    groundingContext.clearRect(0,0,groundingCanvas.width,groundingCanvas.height);
    groundingCanvas.classList.add("hidden");
    groundingInfo.classList.add("hidden");

    if (!grounding ||grounding.available !== true) {
        return;
    }

    // -----------------------------------------
    // Validate coordinates
    // -----------------------------------------

    const x =Number(grounding.x);
    const y =Number(grounding.y);
    const width =Number(grounding.width);
    const height =Number(grounding.height);

    if (!Number.isFinite(x) ||!Number.isFinite(y) ||!Number.isFinite(width) ||!Number.isFinite(height)) {
        return;
    }

    // Coordinates must be normalized 0-1
    if (x < 0 ||y < 0 ||width <= 0 ||height <= 0 ||x + width > 1.01 ||y + height > 1.01) {
        return;
    }

    // -----------------------------------------
    // Match canvas to displayed image
    // -----------------------------------------

    groundingCanvas.width =preview.clientWidth;
    groundingCanvas.height =preview.clientHeight;
    groundingCanvas.style.width =`${preview.clientWidth}px`;
    groundingCanvas.style.height =`${preview.clientHeight}px`;

    // -----------------------------------------
    // Convert normalized coordinates
    // to displayed pixel coordinates
    // -----------------------------------------

    const boxX =x * groundingCanvas.width;
    const boxY =y * groundingCanvas.height;
    const boxWidth =width * groundingCanvas.width;
    const boxHeight =height * groundingCanvas.height;

    // -----------------------------------------
    // Draw bounding box
    // -----------------------------------------

    groundingContext.strokeStyle ="#00ff66";
    groundingContext.lineWidth =3;
    groundingContext.strokeRect(boxX,boxY,boxWidth,boxHeight);

    // -----------------------------------------
    // Draw label
    // -----------------------------------------

    const label =grounding.label ||"Detected feature";

    groundingContext.font ="bold 14px Arial";

    const textWidth =groundingContext.measureText(label).width;
    const labelHeight = 24;

    groundingContext.fillStyle ="rgba(0, 0, 0, 0.75)";
    groundingContext.fillRect(boxX,Math.max(0,boxY - labelHeight),textWidth + 16,labelHeight);
    groundingContext.fillStyle ="#ffffff";
    groundingContext.fillText(label,boxX + 8,Math.max(17,boxY - 7));
    groundingCanvas.classList.remove("hidden");
    groundingInfo.textContent =`Visual grounding: ${label}`;
    groundingInfo.classList.remove("hidden");
}

// =====================================================
// IMAGE PREVIEW
// =====================================================

imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];
    if (!file) {
    preview.classList.add("hidden");
    previewWrapper.classList.add("hidden");
    uploadBox.classList.remove("has-image");
    drawGrounding(null);
    return;
}
    hideError();
    answerSection.classList.add("hidden");
drawGrounding(null);
    const isTiff = /\.(tif|tiff)$/i.test(file.name);

    try {
        if (isTiff) {
            const formData = new FormData();
            formData.append("image", file);
            const response =await fetch("/preview", {
                    method: "POST",
                    body: formData
                });
            if (!response.ok) {
                const data =await response.json().catch(() => ({}));

                throw new Error(data.error ||"Unable to create TIFF preview.");
            }
            const blob =await response.blob();
            preview.src =URL.createObjectURL(blob);
        } else {
            preview.src =URL.createObjectURL(file);
        }
        preview.classList.remove("hidden");
        previewWrapper.classList.remove("hidden");
        uploadBox.classList.add("has-image");
        preview.onload = () => {
            groundingCanvas.width =preview.clientWidth;
    groundingCanvas.height = preview.clientHeight;
};
    } catch (error) {
        console.error(error);
        showError(error.message ||"Unable to preview this image."
        );
    }
});

// =====================================================
// ASK SATQUERY
// =====================================================

askButton.addEventListener("click", async () => {
const image = imageInput.files[0];
const question =questionInput.value.trim();

// -----------------------------------------------
// Validate image
// -----------------------------------------------

if (!image) {
    showError("Please upload a satellite image.");
    return;
}

// -----------------------------------------------
// Validate question
// -----------------------------------------------

if (!question) {
    showError("Please enter a question.");
    return;
}

// -----------------------------------------------
// Reset UI
// -----------------------------------------------

hideError();
answerSection.classList.add("hidden");
loading.classList.remove("hidden");
askButton.disabled = true;
askButton.textContent = "Analyzing...";

try {

    // -------------------------------------------
    // Create multipart form data
    // -------------------------------------------

    const formData = new FormData();
    formData.append("image", image);
    formData.append("question", question);

    // -------------------------------------------
    // Send request to our backend
    // -------------------------------------------

    const controller =new AbortController();
const requestTimeout =setTimeout(
        () => controller.abort(),
        50000
    );

let response;
try {
    response = await fetch("/ask",{
            method: "POST",
            body: formData,
            signal:controller.signal
        }
    );
} catch (error) {
    if (error.name === "AbortError") {
        throw new Error("The analysis is taking too long. Please try again.");
    }
    throw error;
} finally {
    clearTimeout(requestTimeout);
}

    // -------------------------------------------
    // Read backend response
    // -------------------------------------------

    const responseText =await response.text();
    console.log("Backend HTTP status:",response.status);
    console.log("Backend raw response:",responseText);

    // -------------------------------------------
    // Parse JSON
    // -------------------------------------------

    let data;
    try {
        data = JSON.parse(responseText);
    } catch (parseError) {
        console.error("Backend returned invalid JSON:",responseText);
        throw new Error(`Server returned an invalid response (HTTP ${response.status}).`);
    }

    // -------------------------------------------
    // Handle backend errors
    // -------------------------------------------

    if (!response.ok) {
        throw new Error(data.error ||"The request could not be completed.");
    }

    // -------------------------------------------
    // Validate answer
    // -------------------------------------------

    if (!data.answer) {
        throw new Error("The AI did not return an answer.");
    }

    // -------------------------------------------
    // Display answer
    // -------------------------------------------

    answerElement.textContent =formatAnswer(data.answer,data.answerStyle);
    drawGrounding(data.grounding);
const answerType =document.getElementById("answerType");
if (data.answerStyle === "detailed") {
    answerType.textContent ="Descriptive answer";
} else {
    answerType.textContent ="Quick response";
}
answerType.classList.remove("hidden");
answerSection.classList.remove("hidden");

    // -------------------------------------------
    // Optional debugging information
    // -------------------------------------------

    console.log("Task type:",data.taskType);
    console.log("Image:",data.image);
    console.log("Processing time:",data.processingTimeMs,"ms");
}
catch (error) {
    console.error("SatQuery frontend error:",error);
    showError(error.message ||"Unable to analyze the image. Please try again.");
}
finally {
    loading.classList.add("hidden");
    askButton.disabled = false;
    askButton.textContent ="Analyze Satellite Image";
}
});

// =====================================================
// ERROR HANDLING
// =====================================================

function showError(message) {
errorElement.textContent = message;
errorSection.classList.remove("hidden");
}

function hideError() {
errorSection.classList.add("hidden");
}