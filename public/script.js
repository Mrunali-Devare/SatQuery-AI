const imageInput = document.getElementById("imageInput");
const preview = document.getElementById("preview");
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

function formatAnswer(text) {

if (!text) return "";

return text
    // Remove Markdown bold / italic
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/\*/g, "")

    // Remove Markdown headings
    .replace(/^#{1,6}\s*/gm, "")

    // Remove backticks
    .replace(/`/g, "")

    // Convert HTML <br> tags to line breaks
    .replace(/<br\s*\/?>/gi, "\n")

    // Put numbered points on separate lines
    .replace(/\s+(\d+\.\s+)/g, "\n$1")

    // Remove excessive blank lines
    .replace(/\n{3,}/g, "\n\n")

    .trim();

}

// =====================================================
// IMAGE PREVIEW
// =====================================================

imageInput.addEventListener("change", () => {


const file = imageInput.files[0];

if (!file) {

    preview.classList.add("hidden");

    return;
}

const imageURL = URL.createObjectURL(file);

preview.src = imageURL;

preview.classList.remove("hidden");

// Remove previous answer/error when a new image is selected
answerSection.classList.add("hidden");
hideError();


});

// =====================================================
// ASK SATQUERY
// =====================================================

askButton.addEventListener("click", async () => {

const image = imageInput.files[0];

const question =
    questionInput.value.trim();


// -----------------------------------------------
// Validate image
// -----------------------------------------------

if (!image) {

    showError(
        "Please upload a satellite image."
    );

    return;
}


// -----------------------------------------------
// Validate question
// -----------------------------------------------

if (!question) {

    showError(
        "Please enter a question."
    );

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

    const response = await fetch("/ask", {

        method: "POST",

        body: formData

    });


    // -------------------------------------------
    // Read backend response
    // -------------------------------------------

    const responseText =
        await response.text();


    console.log(
        "Backend HTTP status:",
        response.status
    );

    console.log(
        "Backend raw response:",
        responseText
    );


    // -------------------------------------------
    // Parse JSON
    // -------------------------------------------

    let data;

    try {

        data = JSON.parse(responseText);

    } catch (parseError) {

        console.error(
            "Backend returned invalid JSON:",
            responseText
        );

        throw new Error(
            `Server returned an invalid response (HTTP ${response.status}).`
        );

    }


    // -------------------------------------------
    // Handle backend errors
    // -------------------------------------------

    if (!response.ok) {

        throw new Error(
            data.error ||
            "The request could not be completed."
        );

    }


    // -------------------------------------------
    // Validate answer
    // -------------------------------------------

    if (!data.answer) {

        throw new Error(
            "The AI did not return an answer."
        );

    }


    // -------------------------------------------
    // Display answer
    // -------------------------------------------

    answerElement.textContent =
        formatAnswer(data.answer);

    answerSection.classList.remove("hidden");


    // -------------------------------------------
    // Optional debugging information
    // -------------------------------------------

    console.log(
        "Task type:",
        data.taskType
    );

    console.log(
        "Image:",
        data.image
    );

    console.log(
        "Processing time:",
        data.processingTimeMs,
        "ms"
    );

}

catch (error) {

    console.error(
        "SatQuery frontend error:",
        error
    );

    showError(
        error.message ||
        "Unable to analyze the image. Please try again."
    );

}

finally {

    loading.classList.add("hidden");

    askButton.disabled = false;

    askButton.textContent =
        "Analyze Satellite Image";

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
