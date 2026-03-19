const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const docInfo = document.getElementById("doc-info");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatWindow = document.getElementById("chat-window");

// ─── 1. PDF Upload Handling ──────────────────────────────────────────────────
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
        handleUpload(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) {
        handleUpload(e.target.files[0]);
    }
});

async function handleUpload(file) {
    if (file.type !== "application/pdf") {
        alert("❌ Please upload a valid PDF file.");
        return;
    }

    // UI Loading State
    const statusText = document.getElementById("upload-status");
    statusText.innerText = "Parsing PDF...";
    dropZone.style.pointerEvents = "none";
    dropZone.style.opacity = "0.7";

    const formData = new FormData();
    formData.append("pdf", file);

    try {
        const res = await fetch("/upload", { method: "POST", body: formData });
        const data = await res.json();
        
        if (res.ok && data.success) {
            // Success UI changes
            dropZone.style.display = "none";
            docInfo.style.display = "block";
            document.getElementById("doc-name").innerText = data.filename;
            document.getElementById("doc-pages").innerText = `${data.pages} Pages loaded`;
            
            chatInput.disabled = false;
            sendBtn.disabled = false;
            chatInput.placeholder = "Ask a question about your PDF...";
            chatInput.focus();
            
            appendAiMessage(`✅ Successfully analyzed **${data.filename}** (${data.pages} pages). What would you like to know from it?`);
        } else {
            throw new Error(data.error || "Failed to parse PDF.");
        }
    } catch (e) {
        console.error(e);
        alert(e.message);
        statusText.innerText = "Click to Upload PDF";
        dropZone.style.pointerEvents = "auto";
        dropZone.style.opacity = "1";
    }
}

// ─── 2. Chat Q&A Interaction (SSE Streams) ──────────────────────────────────
chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    // Append User Message
    appendUserMessage(msg);
    chatInput.value = "";
    
    // Create AI Bubble context
    const aiBubbleId = createAiBubble();
    const bubbleContent = document.querySelector(`#${aiBubbleId} .bubble`);
    
    chatInput.disabled = true;
    sendBtn.disabled = true;

    try {
        const response = await fetch(`/chat?message=${encodeURIComponent(msg)}`);
        
        // Remove loading dots
        bubbleContent.innerHTML = "";
        let fullMarkdownText = "";

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            const chunkStr = decoder.decode(value, { stream: true });
            const events = chunkStr.split("\n\n").filter(Boolean);
            
            for (const ev of events) {
                if (ev.startsWith("data: ")) {
                    const dataStr = ev.substring(6);
                    if (dataStr === "[DONE]") break;
                    
                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.error) {
                            bubbleContent.innerHTML += `<br><span style="color:red">Error: ${parsed.error}</span>`;
                        } else if (parsed.chunk) {
                            fullMarkdownText += parsed.chunk;
                            // Parse markdown beautifully using Marked.js
                            bubbleContent.innerHTML = marked.parse(fullMarkdownText);
                            chatWindow.scrollTop = chatWindow.scrollHeight;
                        }
                    } catch (err) {}
                }
            }
        }
    } catch (e) {
        bubbleContent.innerHTML = "<span style='color:red;'>Connection error. Please try again.</span>";
    }

    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
});

// ─── UI Helpers ─────────────────────────────────────────────────────────────
function appendUserMessage(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "message user-message";
    wrapper.innerHTML = `
        <div class="avatar"></div>
        <div class="bubble">${escapeHtml(text)}</div>
    `;
    chatWindow.appendChild(wrapper);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function createAiBubble() {
    const id = "ai-" + Date.now();
    const wrapper = document.createElement("div");
    wrapper.className = "message ai-message";
    wrapper.id = id;
    wrapper.innerHTML = `
        <div class="avatar"><i data-lucide="bot"></i></div>
        <div class="bubble">
            <div class="loader-dots">
                <div class="dot"></div>
                <div class="dot"></div>
                <div class="dot"></div>
            </div>
        </div>
    `;
    chatWindow.appendChild(wrapper);
    lucide.createIcons();
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return id;
}

function appendAiMessage(markdownText) {
    const wrapper = document.createElement("div");
    wrapper.className = "message ai-message";
    wrapper.innerHTML = `
        <div class="avatar"><i data-lucide="bot"></i></div>
        <div class="bubble">${marked.parse(markdownText)}</div>
    `;
    chatWindow.appendChild(wrapper);
    lucide.createIcons();
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(unsafe) {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
