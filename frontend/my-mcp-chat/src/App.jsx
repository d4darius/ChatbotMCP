import { useState } from "react";
import { Send, Server, Database } from "lucide-react";

function App() {
  // State for the inputs and messages
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("openai");
  const [messages, setMessages] = useState([]);
  const [currentSparql, setCurrentSparql] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const sendMessage = async () => {
    if (!input) return;

    // Add user message to UI immediately
    const userMsg = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);
    setCurrentSparql(null); // Reset SPARQL for new turn

    try {
      const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input, model: selectedModel }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMsg = { role: "assistant", content: "" };

      // Add a placeholder assistant message we will update live
      setMessages((prev) => [...prev, assistantMsg]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);

        // Custom Logic: parse out our special backend marker
        if (chunk.includes("__TOOL_CALL__:")) {
          const split = chunk.split("__TOOL_CALL__:");
          const query = split[1].split("\n\n")[0]; // Extract query
          setCurrentSparql(query);
        } else {
          // Standard text token
          assistantMsg.content += chunk;
          // Force React to update the specific message in the list
          setMessages((prev) => [...prev.slice(0, -1), { ...assistantMsg }]);
        }
      }
    } catch (err) {
      console.error("Error", err);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar: Model Selection & SPARQL Visualizer */}
      <div className="w-1/3 bg-white p-6 border-r flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Server size={20} /> Settings
          </h2>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Model Selection
          </label>
          <select
            className="w-full p-2 border rounded-md"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            <option value="openai">openai</option>
            <option value="groq">groq</option>
            <option value="ollama">ollama</option>
          </select>
        </div>

        {/* The "Live" SPARQL Window */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <h3 className="font-semibold mb-2 flex items-center gap-2 text-blue-600">
            <Database size={18} /> Live Graph Query
          </h3>
          <div className="flex-1 bg-slate-900 text-green-400 p-4 rounded-lg font-mono text-sm overflow-auto">
            {currentSparql ? (
              <pre>{currentSparql}</pre>
            ) : (
              <span className="text-gray-500 italic">
                Waiting for tool usage...
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="w-2/3 flex flex-col p-6">
        <div className="flex-1 overflow-y-auto space-y-4 mb-4">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`p-4 rounded-lg max-w-[80%] ${
                msg.role === "user"
                  ? "bg-blue-600 text-white self-end ml-auto"
                  : "bg-white shadow-sm self-start"
              }`}
            >
              {msg.content}
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            className="flex-1 p-3 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Ask your graph..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />
          <button
            onClick={sendMessage}
            disabled={isStreaming}
            className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
