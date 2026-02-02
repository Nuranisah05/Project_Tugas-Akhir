import { useState, useEffect, useRef } from "react";
import "./App.css";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,      // ✅ ini kunci: newline jadi <br>
  headerIds: false,
  mangle: false,
});

function App() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [dark, setDark] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ====== SMART AUTO SCROLL ======
  const chatBoxRef = useRef(null);
  const chatEndRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Listen scroll user: kalau user scroll ke atas -> autoScroll = false
  useEffect(() => {
    const chatBox = chatBoxRef.current;
    if (!chatBox) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = chatBox;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      const isAtBottom = distanceFromBottom < 80;

      setAutoScroll(isAtBottom);
      setShowScrollButton(!isAtBottom); // ⬅️ ini kuncinya
    };

    chatBox.addEventListener("scroll", handleScroll);
    return () => chatBox.removeEventListener("scroll", handleScroll);
  }, []);


  // Scroll ke bawah hanya kalau user memang di bawah
  useEffect(() => {
    if (!autoScroll) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading, autoScroll]);

  // ====== DARK MODE PERSIST (LOCALSTORAGE) ======
  useEffect(() => {
    const saved = localStorage.getItem("dark-mode");
    if (saved === "true") setDark(true);
  }, []);

  useEffect(() => {
    localStorage.setItem("dark-mode", String(dark));
  }, [dark]);

  // ====== AUTO RESPONSIVE SIDEBAR ======
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) setSidebarOpen(false);
      else setSidebarOpen(true);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ====== LOAD SESSIONS AWAL ======
  useEffect(() => {
    const init = async () => {
      const res = await fetch("http://localhost:3001/sessions");
      const data = await res.json();
  
      if (!Array.isArray(data) || data.length === 0) {
        const newRes = await fetch("http://localhost:3001/sessions", {
          method: "POST",
        });
        const newSession = await newRes.json();
  
        setSessions([newSession]);
        setSelectedSessionId(newSession.id);
        localStorage.setItem("activeSessionId", newSession.id);
        loadSessionMessages(newSession.id);
        return;
      }
  
      setSessions(data);
  
      // 🔥 AMBIL SESSION TERAKHIR
      const savedId = localStorage.getItem("activeSessionId");
      const targetSession =
        data.find((s) => s.id === savedId) || data[0];
  
      setSelectedSessionId(targetSession.id);
      loadSessionMessages(targetSession.id);
    };
  
    init();
  }, []);
  

  // ====== LOAD PESAN DARI 1 SESSION ======
  const loadSessionMessages = async (id) => {
    try {
      const res = await fetch(`http://localhost:3001/sessions/${id}`);
      const data = await res.json();

      if (!Array.isArray(data)) {
        setMessages([]);
        return;
      }

      // normalize sender: backend "ai" -> frontend "bot"
      const formatted = data.map((m) => ({
        sender: m.sender === "ai" ? "bot" : m.sender,
        text: m.text || "",
      }));

      setMessages(formatted);
    } catch (e) {
      console.error("Gagal load messages:", e);
    }
  };

  // ====== PILIH SESSION ======
  const handleSelectSession = (id) => {
    setSelectedSessionId(id);
    loadSessionMessages(id);

    // di mobile: auto tutup sidebar setelah pilih chat
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // ====== CHAT BARU ======
  const handleNewChat = async () => {
    try {
      const res = await fetch("http://localhost:3001/sessions", {
        method: "POST",
      });
      const newSession = await res.json();

      setSessions((prev) => [newSession, ...prev]);
      setSelectedSessionId(newSession.id);
      loadSessionMessages(newSession.id);

      if (window.innerWidth < 1024) setSidebarOpen(false);
    } catch (e) {
      console.error("Gagal buat session:", e);
    }
  };

  // ====== HAPUS SESSION ======
  const handleDeleteSession = async (id) => {
    if (!window.confirm("Hapus chat ini?")) return;

    try {
      await fetch(`http://localhost:3001/sessions/${id}`, {
        method: "DELETE",
      });

      const updated = sessions.filter((s) => s.id !== id);
      setSessions(updated);

      if (id === selectedSessionId) {
        if (updated.length > 0) {
          setSelectedSessionId(updated[0].id);
          loadSessionMessages(updated[0].id);
        } else {
          await handleNewChat();
        }
      }
    } catch (e) {
      console.error("Gagal hapus session:", e);
    }
  };

  // ====== KIRIM PESAN ======
  const sendMessage = async () => {
    if (!input.trim() || !selectedSessionId) return;

    const question = input.trim();

    setMessages((prev) => [...prev, { sender: "user", text: question }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(
        `http://localhost:3001/sessions/${selectedSessionId}/ask`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        }
      );

      const data = await res.json();
      const answer = data?.answer || "Maaf, tidak ada jawaban.";

      setMessages((prev) => [...prev, { sender: "bot", text: answer }]);

      const updatedSessions = await fetch("http://localhost:3001/sessions").then(
        (r) => r.json()
      );
      if (Array.isArray(updatedSessions)) setSessions(updatedSessions);
    } catch (e) {
      console.error("Gagal kirim pesan:", e);
      setMessages((prev) => [
        ...prev,
        { sender: "bot", text: "❌ Terjadi kesalahan pada server." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const preprocessBotText = (text = "") => {
  let t = text.replace(/\r\n/g, "\n").trim();

  // ✅ Jangan hancurkan format "X: Y"
  // HANYA tambah jarak kalau ":" memang di akhir kalimat dan setelahnya list
  t = t.replace(/:\s*\n(?=\s*(?:[-•●]|\d+\.)\s+)/g, ":\n\n");

  // Bullet "•" -> markdown list
  t = t.replace(/\n?\s*•\s*/g, "\n- ");
  t = t.replace(/\n?\s*●\s*/g, "\n- ");

  // Rapihin newline berlebihan
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
};  
  
  return (
    <div
      className={[
        "wrapper",
        dark ? "dark" : "",
        sidebarOpen ? "sidebar-open" : "sidebar-closed",
      ].join(" ")}
    >
      {/* TOGGLE SIDEBAR */}
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOpen((s) => !s)}
        aria-label="Toggle Sidebar"
        title="Toggle Sidebar"
      >
        {sidebarOpen ? "❮" : "❯"}
      </button>

      <div className="layout">
        {/* SIDEBAR */}
        <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
          <button className="new-chat-btn" onClick={handleNewChat}>
            + New Chat
          </button>

          <div className="sidebar-section">
  Chats
</div>

          <div className="sessions-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={
                  "session-item" + (s.id === selectedSessionId ? " active" : "")
                }
              >
                <div
                  className="session-left"
                  onClick={() => handleSelectSession(s.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="session-title">{s.title || "Chat"}</div>

                  {s.lastMessage && (
                    <div className="session-preview">
                      {s.lastMessage.slice(0, 40)}...
                    </div>
                  )}

<div className="sidebar-header">
  <div className="sidebar-brand">
    <img src="/avatar.png" alt="PancaAI" />
    <div>
      <h2>PancaAI</h2>
      <span>Asisten PPKN</span>
    </div>
  </div>
</div>

                </div>

                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSession(s.id);
                  }}
                  aria-label="Delete chat"
                  title="Hapus chat"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* MAIN CHAT */}
        <main className="chat-main">
  <header className="chat-header">
    <div className="header-spacer" />
    <h1 className="header-title">PancaAI</h1>

    <button
      className="toggle-theme"
      onClick={() => setDark((v) => !v)}
      aria-label="Toggle Theme"
      title="Toggle Theme"
    >
      {dark ? "☀️" : "🌙"}
    </button>
  </header>

  {/* CHAT SCROLL AREA */}
  <div className="chat-box" ref={chatBoxRef}>
    {messages.map((msg, i) => (
      <div key={i} className={`row ${msg.sender}`}>
        {msg.sender === "bot" && (
          <img src="/avatar.png" className="avatar" alt="AI" />
        )}
        <div className={`bubble ${msg.sender}`}>
  {msg.sender === "bot" ? (
    <div
    className="markdown"
    dangerouslySetInnerHTML={{
      __html: marked.parse(preprocessBotText(msg.text || "")),
    }}
  />  
  ) : (
    <div className="plain">{msg.text}</div>
  )}
</div>
      </div>
    ))}

    {loading && (
      <div className="row bot">
        <img src="/avatar.png" className="avatar" alt="AI" />
        <div className="bubble bot typing">
          <span className="dot"></span>
          <span className="dot"></span>
          <span className="dot"></span>
        </div>
      </div>
    )}

    <div ref={chatEndRef} />
  </div>

  {/* ✅ TOMBOL SCROLL — DI LUAR CHAT BOX */}
  {showScrollButton && (
    <button
      className="scroll-to-bottom"
      onClick={() =>
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
      }
      aria-label="Scroll to bottom"
    >
      ↓
    </button>
  )}

  <div className="input-area">
    <input
      type="text"
      placeholder="Tanyakan sesuatu..."
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && sendMessage()}
    />
    <button className="send-btn" onClick={sendMessage}>
      ➤
    </button>
  </div>

  <footer className="footer">
    © 2025 AI PPKN Assistant — Nuranisah
  </footer>
</main>

      </div>
    </div>
  );
}

export default App;
