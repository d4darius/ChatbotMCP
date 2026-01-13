import { useState } from "react";
import { Send, Server, Database } from "lucide-react";

const SparqlFormatter = ({ query }) => {
  if (!query)
    return (
      <span className="text-slate-600 italic text-xs">
        Waiting for query...
      </span>
    );

  // 1. Helper to colorize specific SPARQL keywords
  const highlightSyntax = (line) => {
    // Simple heuristic: colorize common keywords
    const keywords = [
      "SELECT",
      "DISTINCT",
      "WHERE",
      "LIMIT",
      "VALUES",
      "OPTIONAL",
      "FILTER",
    ];
    let formattedLine = line;
    return formattedLine;
  };

  const formatted = query.replace(/#/g, "\n#");

  return (
    <div className="font-mono text-xs leading-relaxed">
      {formatted.split("\n").map((line, i) => {
        const isComment = line.trim().startsWith("#");
        const content = line.trim() === "" ? "\u00A0" : line; // Preserve empty lines

        return (
          <div
            key={i} // React uses this index to know if the line is "new"
            className={`
              pl-2 mb-0.5 border-l-2 border-transparent hover:border-slate-700 transition-colors
              animate-slide-in  /* <--- THIS TRIGGERS THE ANIMATION FOR NEW LINES */
              ${isComment ? "text-slate-500 italic mt-2" : "text-green-400"}
            `}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
};

function App() {
  // State for the inputs and messages
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("openai");
  const [messages, setMessages] = useState([]);
  const [currentSparql, setCurrentSparql] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMsg = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    const currentInput = input;
    setInput("");
    setIsStreaming(true);
    setCurrentSparql(null);

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: currentInput,
          model: selectedModel,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // FIX 1: Use { stream: true } to handle special characters correctly
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split("\n\n");
        buffer = lines.pop(); // Keep the last partial line in the buffer

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("data: ")) {
            try {
              const jsonStr = trimmedLine.replace("data: ", "");
              const parsed = JSON.parse(jsonStr);

              if (parsed.type === "tool") {
                setCurrentSparql(parsed.data);
              } else if (parsed.type === "message") {
                // FIX 2: IMMUTABLE STATE UPDATE (The Anti-Stutter Fix)
                setMessages((prev) => {
                  // Create a shallow copy of the array
                  const newHistory = [...prev];
                  const lastIndex = newHistory.length - 1;
                  const lastMsg = newHistory[lastIndex];

                  // Create a NEW object for the updated message (Do not mutate lastMsg directly!)
                  newHistory[lastIndex] = {
                    ...lastMsg,
                    content: lastMsg.content + parsed.data,
                  };

                  return newHistory;
                });
              }
            } catch (e) {
              console.error("Error parsing JSON chunk", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Streaming error:", error);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar: Model Selection & SPARQL Visualizer */}
      <div className="w-1/2 bg-white p-6 border-r flex flex-col gap-6">
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
            <SparqlFormatter query={currentSparql} />
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="w-1/2 flex flex-col p-6">
        <div className="flex-1 overflow-y-auto space-y-4 mb-4">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex w-full ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[75%] px-5 py-3.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-br-none"
                    : "bg-slate-100 text-slate-800 rounded-bl-none border border-slate-200"
                }`}
              >
                {/* Label for Assistant */}
                {msg.role === "assistant" && (
                  <div className="text-[10px] uppercase font-bold text-slate-400 mb-1 tracking-wider">
                    Agent
                  </div>
                )}

                {/* The Message Content */}
                <span className="whitespace-pre-wrap break-words break-all">
                  {msg.content}
                </span>

                {/* THE CURSOR ANIMATION */}
                {/* Show only if: It's the bot + It's the last message + We are currently streaming */}
                {msg.role === "assistant" &&
                  isStreaming &&
                  idx === messages.length - 1 && (
                    <span className="inline-block w-2 h-4 ml-1 align-middle bg-slate-400 animate-pulse rounded-sm"></span>
                  )}
              </div>
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
