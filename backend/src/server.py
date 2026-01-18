import asyncio
import json
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

@app.get("/", response_class=HTMLResponse)
async def root():
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