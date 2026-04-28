import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// Gemini API 基础 URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// 从环境变量获取配置
const AUTH_KEY = Deno.env.get("key"); 
const GEMINI_API_KEYS_STR = Deno.env.get("apikey"); 

// 解析多个 API Keys
let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0);
}

function getRandomApiKey(): string {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error("没有可用的 API Key");
  }
  return GEMINI_API_KEYS[Math.floor(Math.random() * GEMINI_API_KEYS.length)];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!AUTH_KEY || GEMINI_API_KEYS.length === 0) {
      return new Response(JSON.stringify({ error: "服务器环境变量(key或apikey)未正确配置" }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    let clientKey = "";
    const authHeader = req.headers.get("Authorization");
    if (authHeader) clientKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    else clientKey = req.headers.get("x-api-key")?.trim() || url.searchParams.get("key")?.trim() || "";

    if (!clientKey || clientKey !== AUTH_KEY) {
      return new Response(JSON.stringify({ error: "认证失败：无效的 API 密钥" }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const selectedApiKey = getRandomApiKey();
    
    // ====================================================================
    // 动态获取 Google 真实的可用模型列表，并转换为 OpenAI 格式
    // ====================================================================
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      const geminiModelsUrl = `${GEMINI_API_BASE}/v1beta/models?key=${selectedApiKey}`;
      const response = await fetch(geminiModelsUrl);
      
      if (!response.ok) {
        return new Response(JSON.stringify({ error: "向 Google 获取模型列表失败" }), { 
          status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
      
      const data = await response.json();
      
      // 过滤出 gemini 模型，并将其格式化为 OpenAI 客户端期望的样子
      const models = (data.models || [])
        .filter((m: any) => m.name.includes("gemini")) 
        .map((m: any) => ({
          id: m.name.replace("models/", ""), // 例如将 "models/gemini-1.5-flash" 提取为 "gemini-1.5-flash"
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "google",
          permission: [],
          root: m.name.replace("models/", ""),
          parent: null
        }));

      return new Response(JSON.stringify({ object: "list", data: models }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // ====================================================================
    // 兼容 OpenAI 聊天请求
    // ====================================================================
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const openAiReq = await req.json();
      
      // 直接使用客户端请求的模型名称，不做任何画蛇添足的映射
      const targetModel = openAiReq.model || "gemini-1.5-flash";

      const contents: any[] = [];
      let system_instruction: any = undefined;

      for (const msg of openAiReq.messages || []) {
        if (msg.role === "system") {
          system_instruction = { parts: [{ text: msg.content }] };
        } else {
          contents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }]
          });
        }
      }

      const geminiBody = {
        contents,
        system_instruction,
        generationConfig: {
          temperature: openAiReq.temperature,
          maxOutputTokens: openAiReq.max_tokens,
          topP: openAiReq.top_p,
        }
      };

      const isStream = openAiReq.stream === true;
      const apiAction = isStream ? "streamGenerateContent?alt=sse" : "generateContent";
      const targetUrl = `${GEMINI_API_BASE}/v1beta/models/${targetModel}:${apiAction}?key=${selectedApiKey}`;

      const geminiResponse = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiResponse.ok) {
        const err = await geminiResponse.text();
        return new Response(err, { status: geminiResponse.status, headers: corsHeaders });
      }

      if (!isStream) {
        const geminiData = await geminiResponse.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const openAiResp = {
          id: "chatcmpl-" + crypto.randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }]
        };
        return new Response(JSON.stringify(openAiResp), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let buffer = "";
      const streamTransformer = new TransformStream({
        transform(chunk, controller) {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim() === "") continue;
            if (line.startsWith("data: ")) {
              const dataStr = line.slice(6).trim();
              if (dataStr === "[DONE]") continue; 
              try {
                const data = JSON.parse(dataStr);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  const openAiChunk = {
                    id: "chatcmpl-" + crypto.randomUUID().substring(0, 8),
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: targetModel,
                    choices: [{ delta: { content: text }, index: 0, finish_reason: null }]
                  };
                  controller.enqueue(`data: ${JSON.stringify(openAiChunk)}\n\n`);
                }
              } catch (e) {}
            }
          }
        },
        flush(controller) {
          controller.enqueue("data: [DONE]\n\n");
        }
      });

      const responseStream = geminiResponse.body
        ?.pipeThrough(new TextDecoderStream())
        ?.pipeThrough(streamTransformer)
        ?.pipeThrough(new TextEncoderStream());

      return new Response(responseStream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }

    // ====================================================================
    // 原生 Gemini 协议兜底转发
    // ====================================================================
    const targetPath = url.pathname;
    const targetUrl = `${GEMINI_API_BASE}${targetPath}?key=${selectedApiKey}`;
    
    const forwardHeaders = new Headers();
    ["Content-Type", "Accept"].forEach(h => {
      const val = req.headers.get(h);
      if (val) forwardHeaders.set(h, val);
    });

    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
    }

    const geminiResponse = await fetch(targetUrl, { method: req.method, headers: forwardHeaders, body });
    return new Response(geminiResponse.body, { status: geminiResponse.status, headers: { ...corsHeaders, "Content-Type": geminiResponse.headers.get("Content-Type") || "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ error: "服务器内部错误" }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}

serve(handler);
