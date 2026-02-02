import asyncio
import json
import os
import re
import traceback
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import FastAPI
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

# IMPORT YOUR EXISTING AGENT
from agent.mcp_testing_agent import initialize_agent 

app = FastAPI()

_GREETING_RE = re.compile(
    r"^\s*(hi|hello|hey|yo|good (morning|afternoon|evening))[\s!.?]*$",
    re.IGNORECASE,
)

# Cache agents per model/provider
_AGENT_CACHE: dict[str, object] = {}
_AGENT_LOCK = asyncio.Lock()

DEBUG_ERRORS = True

async def get_agent(model: str):
    # Fast path (no lock)
    cached = _AGENT_CACHE.get(model)
    if cached is not None:
        return cached

    # Slow path (init once)
    async with _AGENT_LOCK:
        cached = _AGENT_CACHE.get(model)
        if cached is not None:
            return cached
        agent = await initialize_agent(model)
        _AGENT_CACHE[model] = agent
        return agent

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

def _tool_content(output_data) -> str:
    """Return the raw tool output as a plain string (prefer ToolMessage.content)."""
    if output_data is None:
        return ""
    if hasattr(output_data, "content"):
        return output_data.content or ""
    if isinstance(output_data, str):
        return output_data
    try:
        return json.dumps(output_data, ensure_ascii=False, default=str)
    except Exception:
        return str(output_data)

def _loads_maybe_json(x):
    """Best-effort JSON decode; if not JSON, return x unchanged."""
    if x is None:
        return None
    if not isinstance(x, str):
        return x
    s = x.strip()
    if not s:
        return ""
    try:
        return json.loads(s)
    except Exception:
        return x

def _normalize_tool_output(raw: str):
    """
    Handles cases like:
    - raw == '{"matches_found":1,...}'
    - raw == '"{...}"'  (double-encoded)
    - raw == '[{"id":..., "text":"{...}", "type":"text"}]' (list wrapper)
    Returns: dict/list/str
    """
    obj = _loads_maybe_json(raw)

    # list wrapper: [{"text": "{...}"}]
    if isinstance(obj, list) and obj:
        first = obj[0]
        if isinstance(first, dict) and "text" in first:
            obj = _loads_maybe_json(first.get("text"))

    # double encoded: "\"{...}\""
    if isinstance(obj, str):
        obj2 = _loads_maybe_json(obj)
        obj = obj2

    return obj

def _summarize_tool_result(raw: str, tool_name: str | None = None, max_len: int = 220) -> str:
    raw = raw or ""
    obj = _normalize_tool_output(raw)

    # Tool-specific: find_candidate_entities -> ONLY matches_found
    if tool_name == "find_candidate_entities":
        if isinstance(obj, dict):
            mf = obj.get("matches_found", None)
            if mf is not None:
                return f"Matches found: {mf}"
        # fallback
        return raw[:max_len]

    if tool_name in ("add_triplet"):
        return "Triplet(s) added successfully"

    if tool_name in ("select_aggregate_variable"):
        return "Aggregate variable selected"
            

    # Generic: tools returning {"success": true/false, ...}
    if isinstance(obj, dict) and "success" in obj:
        success_val = obj.get("success")
        is_success = (success_val is True) or (str(success_val).lower() == "true")
        if is_success:
            return "Success"

        for k in ("error", "message", "detail"):
            v = obj.get(k)
            if v:
                return str(v)[:max_len]
        return raw[:max_len]

    return raw[:max_len]

# Allow the Frontend (port 5173) to talk to the Backend (port 8000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str
    model: str

# 1. Where the built frontend is expected inside the backend image
static_dir = os.path.join(os.path.dirname(__file__), "static")
index_path = os.path.join(static_dir, "index.html")

# 2. Mount the React build folder (CSS/JS assets), if present
if os.path.isdir(static_dir):
    assets_dir = os.path.join(static_dir, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

@app.get("/", response_class=HTMLResponse)
async def root():
    # If the React build exists, serve it; otherwise show a simple backend page
    if os.path.isfile(index_path):
        return FileResponse(index_path)
    return "<h1>Welcome to the MCP Backend</h1>"

def _event_brief(ev: dict) -> str:
    try:
        data = ev.get("data") or {}
        return (
            f"event={ev.get('event')} name={ev.get('name')} run_id={ev.get('run_id')} "
            f"data_keys={list(data.keys())}"
        )
    except Exception:
        return str(ev)
    
def _extract_error_text(ev: dict) -> str:
    data = ev.get("data") or {}
    # Different LC versions place it differently
    err = data.get("error") or data.get("exception") or ev.get("error")
    if err is None:
        err = data.get("output")
    return str(err) if err is not None else "Unknown error"

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    if _GREETING_RE.match(req.message or ""):
        async def event_generator():
            payload = json.dumps({"type": "message", "data": "Hello! What would you like to ask about DOREMUS?"})
            yield f"data: {payload}\n\n"
        return StreamingResponse(event_generator(), media_type="text/event-stream")
    
    agent = await get_agent(req.model)

    async def event_generator():
        try:
            # Stream events from the graph
            async for event in agent.astream_events({"messages": [HumanMessage(content=req.message)]}, version="v1"):

                event_type = event["event"]
                event_name = event.get("name") or event.get("metadata", {}).get("name")

                # Use run_id to correlate tool_start/tool_end/tool_error
                run_id = event.get("run_id")
                tool_id = str(run_id) if run_id is not None else None

                # DETECT TOOL START (Name + Args)
                if event_type == "on_tool_start":
                    # Filter out internal LangChain tools if necessary
                    if event_name not in ["__start__", "_Exception"]:
                        tool_input = event.get("data", {}).get("input")
                        yield _sse(
                        {
                            "type": "tool_start",
                            "data": {
                                "id": tool_id,
                                "name": event_name or "tool",
                                "args": tool_input,
                            },
                        }
                    )
            
                # DETECT TOOL CALL (The SPARQL generation)
                if event_type == "on_tool_end":
                    output_data = event.get("data", {}).get("output")

                    if output_data is None:
                        yield _sse(
                            {
                                "type": "tool_error",
                                "data": {
                                    "id": tool_id,
                                    "name": "tool",
                                    "error": "Tool Error",
                                },
                            }
                        )
                        continue
                        
                    raw = _tool_content(output_data)

                    if event_name not in ["__start__"]:

                        # Send summarized output to the trace
                        yield _sse(
                            {
                                "type": "tool_end",
                                "data": {
                                    "id": tool_id,
                                    "name": event_name or "tool",
                                    "output": _summarize_tool_result(raw, tool_name=event_name)
                                },
                            }
                        )

                        # Keep SPARQL update based on raw JSON
                        if raw and "generated_query" in raw:
                            try:
                                json_content = json.loads(raw)
                                query = json_content.get("generated_query")
                                if query:
                                    yield _sse({"type": "sparql_update", "data": query})
                            except Exception:
                                pass
                
                # DETECT ERRORS
                elif event_type == "on_tool_error" or event_type == "on_chain_error":
                    if DEBUG_ERRORS:
                        print("[LC ERROR EVENT]", event)
                    err = event.get("data", {}).get("error")
                    err_text = str(err)
                    yield _sse(
                        {
                            "type": "tool_error",
                            "data": {
                                "id": tool_id,
                                "name": event_name or "tool",
                                "error": err_text[:220],
                            },
                        }
                    )
                
                # DETECT FINAL TEXT ANSWER
                elif event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        yield _sse({
                            "type": "message", 
                            "data": chunk.content
                        })
        except Exception as e:
            # Log server-side, but DON'T leak LangChain error into the chat stream
            error_msg = str(e)
            if DEBUG_ERRORS:
                print("Error during chat processing:", error_msg)
                print(traceback.format_exc(limit=8))

            # Option A: send a generic error event (frontend can ignore or show a toast)
            yield _sse({"type": "error", "data": error_msg[:30]})
            return
    
    return StreamingResponse(event_generator(), media_type="text/event-stream")

# 1. Mount the React build folder (CSS/JS assets)
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(static_dir, "assets")), name="assets")

# 2. Catch-all route: Serve index.html for any other path (React Router support)
@app.get("/{full_path:path}")
async def serve_react_app(full_path: str):
    # If the specific file exists (like favicon.ico), serve it
    file_path = os.path.join(static_dir, full_path)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)
    
    # Otherwise, return the main React app
    return FileResponse(os.path.join(static_dir, "index.html"))