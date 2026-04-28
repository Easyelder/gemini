import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// Gemini API 基础 URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// 从环境变量获取配置
const AUTH_KEY = Deno.env.get("key"); // 用户认证密钥
const GEMINI_API_KEYS_STR = Deno.env.get("apikey"); // Gemini API 密钥（逗号分隔）

// 解析多个 API Keys
let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0);
}

// 随机获取一个 API Key
function getRandomApiKey(): string {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error("没有可用的 API Key");
  }
  const randomIndex = Math.floor(Math.random() * GEMINI_API_KEYS.length);
  return GEMINI_API_KEYS[randomIndex];
}

console.log("=== 服务器启动配置检查 ===");
console.log(`AUTH_KEY 是否已设置: ${AUTH_KEY ? '是' : '否'}`);
console.log(`GEMINI_API_KEYS 数量: ${GEMINI_API_KEYS.length}`);
console.log("========================");

// CORS 头信息
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key",
  "Access-Control-Max-Age": "86400",
};

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  
  console.log(`\n[${requestId}] === 收到请求 ===`);
  console.log(`[${requestId}] 方法: ${req.method} | 路径: ${url.pathname}`);
  
  // 1. 处理 CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!AUTH_KEY || GEMINI_API_KEYS.length === 0) {
      return new Response(JSON.stringify({ error: "服务器配置错误" }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // 2. 鉴权逻辑
    let clientKey = "";
    const googApiKey = req.headers.get("x-goog-api-key");
    const authHeader = req.headers.get("Authorization");
    const xApiKey = req.headers.get("x-api-key");
    const urlKey = url.searchParams.get("key");

    if (googApiKey) clientKey = googApiKey.trim();
    else if (authHeader) clientKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    else if (xApiKey) clientKey = xApiKey.trim();
    else if (urlKey) clientKey = urlKey.trim();

    if (!clientKey || clientKey !== AUTH_KEY) {
      console.log(`[${requestId}] 认证失败`);
      return new Response(JSON.stringify({ error: "认证失败：未提供或无效的 API 密钥" }), { 
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const selectedApiKey = getRandomApiKey();
    
    // 3. 模拟 OpenAI /v1/models 接口 (很多客户端启动时会请求这个来获取模型列表)
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "gemini-1.5-flash", object: "model", created: 1686935002, owned_by: "google" },
          { id: "gemini-1.5-pro", object: "model", created: 1686935002, owned_by: "google" }
        ]
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4. 处理 OpenAI 协议的 /v1/chat/completions 转换
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const openAiReq = await req.json();
      
      // OpenAI 模型映射到 Gemini
      let targetModel = openAiReq.model || "gemini-1.5-flash";
      if (targetModel.includes("gpt-3.5") || targetModel.includes("gpt-4o-mini")) targetModel = "gemini-1.5-flash";
      else if (targetModel.includes("gpt-4")) targetModel = "gemini-1.5-pro";

      // 转换 Messages
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

      console.log(`[${requestId}] 转换 OpenAI 请求 -> ${targetModel} (Stream: ${isStream})`);

      const geminiResponse = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiResponse.ok) {
        const err = await geminiResponse.text();
        console.error(`[${requestId}] Gemini API 报错:`, err);
        return new Response(err, { status: geminiResponse.status, headers: corsHeaders });
      }

      // 4.1 处理非流式响应转换
      if (!isStream) {
        const geminiData = await geminiResponse.json();
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
        
        const openAiResp = {
          id: "chatcmpl-" + crypto.randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        return new Response(JSON.stringify(openAiResp), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      // 4.2 处理流式响应 (SSE) 转换
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
                    id: "chatcmpl-" + requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: targetModel,
                    choices: [{ delta: { content: text }, index: 0, finish_reason: null }]
                  };
                  controller.enqueue(`data: ${JSON.stringify(openAiChunk)}\n\n`);
                }
              } catch (e) {
                // 忽略解析错误（通常是由于结构不完整）
              }
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

    // 5. 如果不是 OpenAI 协议，默认执行原始的透明代理转发 (兼容原生 Gemini 协议调用)
    const targetPath = url.pathname;
    url.searchParams.delete("key");
    url.searchParams.set("key", selectedApiKey);
    const targetUrl = `${GEMINI_API_BASE}${targetPath}${url.search}`;
    
    console.log(`[${requestId}] 原生协议转发到: ${targetPath}`);

    const forwardHeaders = new Headers();
    ["Content-Type", "Accept", "User-Agent", "Accept-Language", "Accept-Encoding"].forEach(h => {
      const val = req.headers.get(h);
      if (val) forwardHeaders.set(h, val);
    });

    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
    }

    const geminiResponse = await fetch(targetUrl, { method: req.method, headers: forwardHeaders, body });

    const responseHeaders = new Headers(corsHeaders);
    ["Content-Type", "Content-Length", "Transfer-Encoding"].forEach(h => {
      const val = geminiResponse.headers.get(h);
      if (val) responseHeaders.set(h, val);
    });

    return new Response(geminiResponse.body, { status: geminiResponse.status, headers: responseHeaders });

  } catch (error) {
    console.error(`[${requestId}] 处理请求时发生错误:`, error);
    return new Response(JSON.stringify({ error: "内部服务器错误", message: error instanceof Error ? error.message : "未知错误" }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}

console.log("Gemini OpenAI 兼容代理服务器已启动...");
serve(handler);
