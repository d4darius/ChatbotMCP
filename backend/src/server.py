import asyncio
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
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

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    agent = await initialize_agent(req.model)

    async def event_generator():
        # Stream events from the graph
        async for event in agent.astream_events({"messages": [HumanMessage(content=req.message)]}, version="v1"):
            event_type = event["event"]
            
            # Detect the Tool Call (The SPARQL generation)
            if event_type == "on_tool_start" and event["name"] == "sparql_tool_name":
                # Send a special marker to the frontend
                yield f"__TOOL_CALL__:{event['data']['input']['query']}\n\n"
            
            # Detect the Final Text Answer
            elif event_type == "on_chat_model_stream":
                content = event["data"]["chunk"].content
                if content:
                    yield content

    return StreamingResponse(event_generator(), media_type="text/event-stream")