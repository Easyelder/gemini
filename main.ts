import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const AUTH_KEY = Deno.env.get("key"); 
const GEMINI_API_KEYS_STR = Deno.env.get("apikey"); 

let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

function getRandomApiKey(): string {
  if (GEMINI_API_KEYS.length === 0) throw new Error("没有可用的 API Key");
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
  
  // 处理跨域预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!AUTH_KEY || GEMINI_API_KEYS.length === 0) {
      return new Response(JSON.stringify({ error: { message: "服务器环境变量(key或apikey)未正确配置" } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 身份验证
    let clientKey = "";
    const authHeader = req.headers.get("Authorization");
    if (authHeader) clientKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    else clientKey = req.headers.get("x-api-key")?.trim() || url.searchParams.get("key")?.trim() || "";

    if (!clientKey || clientKey !== AUTH_KEY) {
      return new Response(JSON.stringify({ error: { message: "认证失败：无效的 API 密钥" } }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const selectedApiKey = getRandomApiKey();
    
    // ====================================================================
    // 动态获取 Google 真实模型列表
    // ====================================================================
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      const geminiModelsUrl = `${GEMINI_API_BASE}/v1beta/models?key=${selectedApiKey}`;
      const response = await fetch(geminiModelsUrl);
      
      if (!response.ok) {
        return new Response(JSON.stringify({ error: { message: "向 Google 获取模型列表失败" } }), { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      const data = await response.json();
      const models = (data.models || [])
        .filter((m: any) => m.name.includes("gemini")) 
        .map((m: any) => ({
          id: m.name.replace("models/", ""),
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "google"
        }));

      return new Response(JSON.stringify({ object: "list", data: models }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ====================================================================
    // 兼容 OpenAI 聊天请求
    // ====================================================================
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const openAiReq = await req.json();
      const targetModel = openAiReq.model || "gemini-1.5-flash";

      const contents: any[] = [];
      let systemInstruction: any = undefined;

      for (const msg of openAiReq.messages || []) {
        // === 核心修复点：安全提取文本内容，兼容字符串和数组格式 ===
        let extractedText = "";
        if (typeof msg.content === "string") {
          extractedText = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 处理复杂结构：[{ type: "text", text: "具体内容" }]
          extractedText = msg.content
            .filter((item: any) => item.type === "text" && item.text)
            .map((item: any) => item.text)
            .join("\n");
        } else {
          continue; // 忽略无法解析的异常内容
        }

        // 处理 system 角色
        if (msg.role === "system") {
          if (extractedText.trim()) {
            systemInstruction = { parts: [{ text: extractedText }] };
          }
          continue;
        }
        
        const role = msg.role === "assistant" ? "model" : "user";

        // 防御性过滤空消息
        if (!extractedText.trim()) continue;

        // 合并连续的相同角色消息
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += "\n\n" + extractedText;
        } else {
          contents.push({ role, parts: [{ text: extractedText }] });
        }
      }

      if (contents.length > 0 && contents[0].role !== "user") {
        contents.unshift({ role: "user", parts: [{ text: " " }] });
      }
      if (contents.length === 0) {
        contents.push({ role: "user", parts: [{ text: " " }] });
      }

      const geminiBody: any = { contents };
      if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

      const generationConfig: any = {};
      if (openAiReq.temperature !== undefined) generationConfig.temperature = openAiReq.temperature;
      if (openAiReq.max_tokens !== undefined) generationConfig.maxOutputTokens = openAiReq.max_tokens;
      if (openAiReq.top_p !== undefined) generationConfig.topP = openAiReq.top_p;
      if (Object.keys(generationConfig).length > 0) geminiBody.generationConfig = generationConfig;

      const isStream = openAiReq.stream === true;
      const apiAction = isStream ? "streamGenerateContent" : "generateContent";
      let targetUrl = `${GEMINI_API_BASE}/v1beta/models/${targetModel}:${apiAction}?key=${selectedApiKey}`;
      if (isStream) {
        targetUrl += "&alt=sse";
      }

      const geminiResponse = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiResponse.ok) {
        const errText = await geminiResponse.text();
        let errorMessage = errText;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.message) {
            errorMessage = errJson.error.message;
          }
        } catch (e) {}

        return new Response(JSON.stringify({
          error: {
            message: `Gemini API 报错: ${errorMessage}`,
            type: "api_error"
          }
        }), { status: geminiResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    return new Response(JSON.stringify({ error: { message: "中转服务器内部错误: " + (error as Error).message } }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}

serve(handler);
