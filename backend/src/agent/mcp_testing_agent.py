import asyncio
import os
from dotenv import load_dotenv
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI
from langchain_groq import ChatGroq
from langchain_anthropic import ChatAnthropic
from langchain_ollama import ChatOllama

from .prompts import agent_system_prompt
from .extended_mcp_client import ExtendedMCPClient

load_dotenv(".env")

recursion_limit = int(os.getenv("GRAPH_RECURSION_LIMIT", "25"))
mcp_url = os.getenv("DOREMUS_MCP_URL", "https://Doremus.fastmcp.app/mcp")
mcp_transport = os.getenv("DOREMUS_MCP_TRANSPORT", "streamable_http")


evaluation_models = {
    "gpt-5.2": "openai",
    "gpt-4.1": "openai",
    "qwen3-coder:30b": "ollama",
    "qwen3-coder:480b": "cloud",
    "ministral-3:14b": "cloud"
}

connections = {
        "DOREMUS_MCP": {
            "transport": mcp_transport,
            "url": mcp_url
    }
}

client = ExtendedMCPClient(
    connections=connections
)

# Helper function to create model based on provider
def create_model(model_name: str):
    """Create a chat model based on provider"""
    provider = evaluation_models[model_name]
    
    if provider == "openai":
        return ChatOpenAI(model=model_name, temperature=0)
    elif provider == "cloud":
        return ChatOllama(
                base_url="https://ollama.com",
                model=model_name,
                client_kwargs={"headers": {"Authorization": f"Bearer {os.getenv('CLOUD_OLLAMA_API_KEY')}"}},
                temperature=0
                )
    elif provider == "ollama":
        return ChatOllama(
            base_url=os.getenv("OLLAMA_API_URL", "https://mcp-kg-ollama.tools.eurecom.fr"),
            model=model_name,
            client_kwargs={"headers": {"Authorization": f"Basic {os.getenv('OLLAMA_API_KEY')}"}},
            stream=True,
            temperature=0
            )
    else:
        raise ValueError(f"Unknown provider: {provider}")
    
# AGENT LLM: Initialize the LLM, bind the tools from the MCP client
async def initialize_agent(model_name: str = "gpt-5.2"):
    tools = await client.get_tools()
    llm = create_model(model_name)
    provider = evaluation_models[model_name]

    print("DOREMUS Assistant configuration:")
    print(f"  provider: {provider}")
    print(f"  selected_model: {model_name}")
    print(f"  recursion_limit: {recursion_limit}")
    print(f"  MCP server: {mcp_url}, transport type: {mcp_transport}\n")

    # Compile the agent using LangGraph's create_react_agent
    agent = create_react_agent(
        llm,
        tools=tools,
        state_modifier=agent_system_prompt
    )
    return agent.with_config({"recursion_limit": recursion_limit})