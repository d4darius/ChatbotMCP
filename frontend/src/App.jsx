import { useState, useEffect, useRef } from "react";
import {
  Send,
  Settings,
  Database,
  Terminal,
  X,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// --- COMPONENT: SPARQL FORMATTER (No Changes) ---
const SparqlFormatter = ({ query }) => {
  if (!query)
    return (
      <span className="text-slate-500 italic text-xs">
        Waiting for query generation...
      </span>
    );

  const KEYWORDS = [
    "SELECT",
    "DISTINCT",
    "WHERE",
    "LIMIT",
    "VALUES",
    "OPTIONAL",
    "FILTER",
    "ORDER",
    "BY",
    "OFFSET",
    "ka",
    "a",
  ];

  const highlightSyntax = (line) => {
    const regex = new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "g");
    return line.split(regex).map((part, index) =>
      KEYWORDS.includes(part) ? (
        <span key={index} className="text-purple-400 font-bold">
          {part}
        </span>
      ) : (
        <span key={index}>{part}</span>
      ),
    );
  };

  return (
    <div className="font-mono text-xs leading-relaxed">
      {query
        .replace(/#/g, "\n#")
        .split("\n")
        .map((line, i) => {
          const isComment = line.trim().startsWith("#");
          return (
            <div
              key={i}
              className={`pl-2 mb-0.5 border-l-2 border-transparent hover:border-slate-700 transition-colors animate-slide-in ${
                isComment ? "text-slate-500 italic mt-2" : "text-green-400"
              }`}
            >
              {isComment
                ? line
                : line.trim() === ""
                  ? "\u00A0"
                  : highlightSyntax(line)}
            </div>
          );
        })}
    </div>
  );
};

// --- COMPONENT: SETTINGS MODAL (No Changes) ---
const SettingsModal = ({ isOpen, onClose, model, setModel }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-slide-in">
        <div className="p-4 border-b flex justify-between items-center bg-slate-50">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Settings size={18} /> Configuration
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-200 rounded-full transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Model Selection
            </label>
            <select
              className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-slate-50"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="openai">openai - gpt-5.2</option>
              <option value="ollama">ollama - qwen3-coder:30b</option>
              <option value="groq">groq - llama-3.3-70b-versatile</option>
            </select>
          </div>
        </div>
        <div className="p-4 bg-slate-50 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

// --- COMPONENT: TOOL CALL CARD (No Changes) ---
const ToolCallCard = ({ tool }) => (
  <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs mb-3 animate-slide-in shadow-sm">
    <div className="flex items-center gap-2 mb-2 text-blue-400 font-semibold border-b border-slate-700 pb-2">
      <Terminal size={14} />
      {tool.name}
    </div>
    <div className="font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(tool.args, null, 2).replace(/[{}"]/g, "")}
    </div>
  </div>
);

// --- MAIN APP ---
function App() {
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("openai");
  const [messages, setMessages] = useState([]);
  const [currentSparql, setCurrentSparql] = useState(null);
  const [toolHistory, setToolHistory] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTraceOpen, setIsTraceOpen] = useState(true);
  const [isSparqlCopied, setIsSparqlCopied] = useState(false);
  const copyResetTimeoutRef = useRef(null);

  const scrollAnchorRef = useRef(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current)
        clearTimeout(copyResetTimeoutRef.current);
    };
  }, []);

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMsg = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    const currentInput = input;
    setInput("");
    setIsStreaming(true);
    setCurrentSparql(null);
    setToolHistory([]);

    // Auto-open trace when a new message starts so the user sees activity
    setIsTraceOpen(true);

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

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(trimmed.replace("data: ", ""));
              if (parsed.type === "tool_start")
                setToolHistory((prev) => [...prev, parsed.data]);
              else if (parsed.type === "sparql_update")
                setCurrentSparql(parsed.data);
              else if (parsed.type === "message") {
                setMessages((prev) => {
                  const newHistory = [...prev];
                  const lastMsg = newHistory[newHistory.length - 1];
                  newHistory[newHistory.length - 1] = {
                    ...lastMsg,
                    content: lastMsg.content + parsed.data,
                  };
                  return newHistory;
                });
              }
            } catch (e) {
              console.error("Parse error", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error", error);
    } finally {
      setIsStreaming(false);
    }
  };

  const copySparqlToClipboard = async () => {
    if (!currentSparql) return;
    try {
      await navigator.clipboard.writeText(currentSparql);

      setIsSparqlCopied(true);
      if (copyResetTimeoutRef.current)
        clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = setTimeout(() => {
        setIsSparqlCopied(false);
      }, 2000);
    } catch (e) {
      console.error("Clipboard copy failed", e);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden">
      {/* --- LEFT SIDEBAR (Visualization) --- */}
      <div className="w-5/12 bg-slate-950 text-slate-200 border-r border-slate-800 flex flex-col shadow-2xl z-10 transition-all duration-300">
        {/* SECTION 1: TOOL EXECUTION HISTORY (Collapsible) */}
        <div
          className={`
            flex flex-col border-b border-slate-800 transition-all duration-300 ease-in-out overflow-hidden
            ${
              isTraceOpen ? "h-1/2" : "h-14"
            } /* Collapsed height matches header size approx */
          `}
        >
          {/* Header - Clickable to Toggle */}
          <div
            onClick={() => setIsTraceOpen(!isTraceOpen)}
            className="p-4 bg-slate-900 border-b border-slate-800 cursor-pointer hover:bg-slate-800/80 transition-colors flex justify-between items-center group"
          >
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 group-hover:text-slate-200">
              <ChevronRight
                size={14}
                className={`transition-transform duration-300 ${
                  isTraceOpen ? "rotate-90" : ""
                }`}
              />
              Execution Trace
            </h3>
            <button className="text-slate-500 hover:text-white transition-colors">
              {isTraceOpen ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          </div>

          {/* List Content - Only visible when open */}
          <div
            className={`flex-1 overflow-y-auto p-4 bg-slate-950/50 ${
              !isTraceOpen && "hidden"
            }`}
          >
            {toolHistory.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-700 italic text-xs space-y-2">
                <Terminal size={24} className="opacity-20" />
                <span>Waiting for agent actions...</span>
              </div>
            ) : (
              toolHistory.map((tool, idx) => (
                <ToolCallCard key={idx} tool={tool} />
              ))
            )}
          </div>
        </div>

        {/* SECTION 2: SPARQL VIEWER (Fills Remaining Space) */}
        {/* 'flex-1' makes this section grab all available vertical space left by the section above */}
        <div className="flex-1 flex flex-col min-h-0 bg-black transition-all duration-300">
          <div className="p-3 bg-slate-900/80 border-t border-b border-slate-800 flex justify-between items-center backdrop-blur">
            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-wider flex items-center gap-2">
              <Database size={14} /> Live Query
            </h3>
            {currentSparql && (
              <div className="flex items-center gap-[5px]">
                <button
                  onClick={copySparqlToClipboard}
                  className={[
                    "text-[10px] px-2 py-0.5 rounded border transition-colors",
                    isSparqlCopied
                      ? "bg-green-900/30 text-green-300 border-green-800"
                      : "bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700",
                  ].join(" ")}
                  title={isSparqlCopied ? "Copied!" : "Copy query to clipboard"}
                  aria-label="Copy SPARQL query to clipboard"
                >
                  {isSparqlCopied ? "Copied" : "Copy"}
                </button>
                <span className="text-[10px] px-2 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-800">
                  Active
                </span>
              </div>
            )}
          </div>
          <div className="flex-1 p-4 overflow-auto">
            <SparqlFormatter query={currentSparql} />
          </div>
        </div>
      </div>

      {/* --- RIGHT SIDE: CHAT AREA --- */}
      <div className="flex-1 flex flex-col bg-white relative">
        <div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-20 pointer-events-none" />
        <div className="flex-1 overflow-y-auto p-6 space-y-6 relative">
          {messages.length === 0 ? (
            <div className="h-full w-full flex flex-col items-center justify-center select-none">
              <img
                src="/sparql.svg"
                alt="RDF Chatbot"
                className="w-40 h-40 opacity-15 grayscale saturate-50"
                draggable="false"
              />
              <div className="mt-4 text-slate-400 text-sm font-semibold tracking-wide">
                RDF Chatbot
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex w-full ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] px-5 py-4 rounded-2xl text-sm leading-relaxed shadow-sm relative ${
                      msg.role === "user"
                        ? "bg-blue-600 text-white rounded-br-none"
                        : "bg-slate-100 text-slate-800 border border-slate-200 rounded-bl-none"
                    }`}
                  >
                    {msg.role === "assistant" && (
                      <div className="text-[10px] uppercase font-bold text-slate-400 mb-1">
                        Agent
                      </div>
                    )}
                    <span className="whitespace-pre-wrap break-words break-all">
                      {msg.content}
                    </span>
                    {msg.role === "assistant" &&
                      isStreaming &&
                      idx === messages.length - 1 && (
                        <span className="inline-block w-2 h-4 ml-1 align-middle bg-slate-400 animate-pulse rounded-sm" />
                      )}
                  </div>
                </div>
              ))}
              <div ref={scrollAnchorRef} />
            </>
          )}
        </div>
        <div className="p-4 border-t border-slate-100 bg-white/80 backdrop-blur">
          <div className="max-w-4xl mx-auto flex gap-3">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-colors border border-slate-200"
              title="Model Settings"
            >
              <Settings size={20} />
            </button>
            <div className="flex-1 relative shadow-sm rounded-xl overflow-hidden border border-slate-200 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
              <input
                className="w-full h-full bg-white p-4 pr-12 outline-none text-slate-700"
                placeholder="Ask your graph..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                onClick={sendMessage}
                disabled={isStreaming || !input.trim()}
                className="absolute right-2 top-2 bottom-2 aspect-square flex items-center justify-center bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white rounded-lg transition-all"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
          <div className="text-center mt-2 text-[10px] text-slate-400">
            Powered by LangChain & MCP
          </div>
        </div>
      </div>
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        model={selectedModel}
        setModel={setSelectedModel}
      />
    </div>
  );
}

export default App;
