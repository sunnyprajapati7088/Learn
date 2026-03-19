const sessionId = crypto.randomUUID();
let activeBookId = null;

const libraryList = document.getElementById("library-list");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatWindow = document.getElementById("chat-window");
const headerInfo = document.querySelector(".header-info");

// ─── 1. Load Library ────────────────────────────────────────────────────────
async function loadBooks() {
    try {
        const res = await fetch("/books");
        const books = await res.json();
        
        libraryList.innerHTML = "";
        
        if (books.length === 0) {
            libraryList.innerHTML = `<div class="loading-text">No books available. <br><br><a href="/admin.html" style="color:var(--accent); text-decoration:none;">Go to Admin Portal →</a></div>`;
            return;
        }

        books.forEach(book => {
            const card = document.createElement("div");
            card.className = "book-card";
            card.innerHTML = `
                <h3>${escapeHtml(book.title)}</h3>
                <p>${escapeHtml(book.description)}</p>
                <div class="meta">${book.pages} pages • ${book.chunkCount} indexed chunks</div>
            `;
            
            card.addEventListener("click", () => selectBook(book, card));
            libraryList.appendChild(card);
        });
    } catch (e) {
        libraryList.innerHTML = `<div class="loading-text" style="color:red">Failed to load library.</div>`;
    }
}

function selectBook(book, cardElement) {
    document.querySelectorAll(".book-card").forEach(c => c.classList.remove("active"));
    cardElement.classList.add("active");
    
    activeBookId = book.id;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.placeholder = `Ask a question about ${book.title}...`;
    chatInput.focus();
    
    headerInfo.innerHTML = `<h2>${escapeHtml(book.title)}</h2><p>${escapeHtml(book.description)}</p>`;
    
    chatWindow.innerHTML = "";
    appendAiMessage(`✅ You're now connected to **${book.title}**. Ask me anything, and I'll only answer using this specific book!`);
}

loadBooks();

// ─── 2. Chat Q&A Interaction (SSE Streams) ──────────────────────────────────
chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeBookId) return alert("Select a book from the library first!");
    
    const msg = chatInput.value.trim();
    if (!msg) return;

    appendUserMessage(msg);
    chatInput.value = "";
    
    const aiBubbleId = createAiBubble();
    const bubbleContent = document.querySelector(`#${aiBubbleId} .bubble`);
    
    chatInput.disabled = true;
    sendBtn.disabled = true;

    try {
        const response = await fetch(`/chat?message=${encodeURIComponent(msg)}&bookId=${activeBookId}`, {
            headers: { "x-session-id": sessionId }
        });
        
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

function appendUserMessage(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "message user-message";
    wrapper.innerHTML = `<div class="avatar"></div><div class="bubble">${escapeHtml(text)}</div>`;
    chatWindow.appendChild(wrapper);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function createAiBubble() {
    const id = "ai-" + Date.now();
    const wrapper = document.createElement("div");
    wrapper.className = "message ai-message";
    wrapper.id = id;
    wrapper.innerHTML = `<div class="avatar"><i data-lucide="bot"></i></div><div class="bubble"><div class="loader-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
    chatWindow.appendChild(wrapper);
    lucide.createIcons();
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return id;
}

function appendAiMessage(markdownText) {
    const wrapper = document.createElement("div");
    wrapper.className = "message ai-message";
    wrapper.innerHTML = `<div class="avatar"><i data-lucide="bot"></i></div><div class="bubble">${marked.parse(markdownText)}</div>`;
    chatWindow.appendChild(wrapper);
    lucide.createIcons();
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(unsafe) { return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
