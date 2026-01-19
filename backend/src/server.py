import asyncio
import json
import os
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

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    agent = await initialize_agent(req.model)

    async def event_generator():
        try:
            # Stream events from the graph
            async for event in agent.astream_events({"messages": [HumanMessage(content=req.message)]}, version="v1"):
                event_type = event["event"]
                print(f"Event type: {event_type}")

                # DETECT TOOL START (Name + Args)
                if event_type == "on_tool_start":
                    # Filter out internal LangChain tools if necessary
                    if event["name"] not in ["__start__", "_Exception"]:
                        payload = json.dumps({
                            "type": "tool_start",
                            "data": {
                                "name": event["name"],
                                "args": event["data"].get("input")
                            }
                        })
                        yield f"data: {payload}\n\n"
            
                # DETECT TOOL CALL (The SPARQL generation)
                if event_type == "on_tool_end":
                    output_data = event.get("data", {}).get("output")

                    content = ""
                    if hasattr(output_data, "content"):
                        content = output_data.content
                    elif isinstance(output_data, str):
                        content = output_data
                    # Parse the JSON inside the ToolMessage to find 'generated_sparql'
                    print(f"Content received: {content}")
                    if content and "generated_query" in content:
                        try:
                            json_content = json.loads(content)
                            if "generated_query" in json_content:
                                query = json_content["generated_query"]
                                    
                                # YIELD JSON EVENT
                                payload = json.dumps({
                                    "type": "sparql_update", 
                                    "data": query
                                })
                                yield f"data: {payload}\n\n"
                        except:
                            pass
                
                # DETECT FINAL TEXT ANSWER
                elif event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        # YIELD JSON EVENT
                        payload = json.dumps({
                            "type": "message", 
                            "data": chunk.content
                        })
                        yield f"data: {payload}\n\n"
        except Exception as e:
            # Send error as a message so it appears in chat
            err_payload = json.dumps({"type": "message", "data": f"[Error: {str(e)}]"})
            print( f"Error during chat processing: {str(e)}" )
            yield f"data: {err_payload}\n\n"
    
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