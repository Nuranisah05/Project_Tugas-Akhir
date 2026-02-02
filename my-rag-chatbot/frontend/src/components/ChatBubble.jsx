export default function ChatBubble({ sender, text }) {
    return (
      <div className={`message ${sender === "user" ? "user" : "bot"}`}>
        {text}
      </div>
    );
  }
  