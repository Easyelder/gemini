import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// Gemini API 基础 URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// 从环境变量获取配置
const AUTH_KEY = Deno.env.get("key"); // 用户认证密钥
const GEMINI_API_KEYS_STR = Deno.env.get("apikey"); // Gemini API 密钥

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

console.log("=== Gemini to OpenAI Proxy 启动 ===");

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  
  // 1. 处理 CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key",
      },
    });
  }

  try {
    // 2. 身份验证
    const authHeader = req.headers.get("Authorization") || "";
    const xGoogKey = req.headers.get("x-goog-api-key") || "";
    let clientKey = xGoogKey || authHeader.replace("Bearer ", "").trim();

    if (clientKey !== AUTH_KEY) {
      console.log(`[${requestId}] 认证失败`);
      return new Response(JSON.stringify({ error: "Invalid API Key" }), { 
        status: 401, 
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });
    }

    // 3. 核心：路径改写逻辑 (解决 404)
    let targetPath = url.pathname;
    
    // 如果软件发的是 OpenAI 标准路径，自动重定向到 Google 的 OpenAI 兼容端点
    if (targetPath.includes("/v1/chat/completions")) {
      targetPath = "/v1beta/openai/v1/chat/completions";
      console.log(`[${requestId}] 检测到 OpenAI 请求，已自动重写路径`);
    } else if (targetPath.includes("/v1/models")) {
      targetPath = "/v1beta/openai/v1/models";
    }

    // 4. 构建转发 URL
    const selectedApiKey = getRandomApiKey();
    const targetUrl = new URL(`${GEMINI_API_BASE}${targetPath}`);
    targetUrl.search = url.search;
    targetUrl.searchParams.set("key", selectedApiKey);

    // 5. 准备转发 Headers
    const forwardHeaders = new Headers(req.headers);
    forwardHeaders.set("host", "generativelanguage.googleapis.com");
    // 必须移除原有的认证头，防止 Google 混淆
    forwardHeaders.delete("Authorization"); 
    forwardHeaders.delete("x-api-key");
    forwardHeaders.delete("x-goog-api-key");

    // 6. 执行转发
    console.log(`[${requestId}] 转发请求: ${targetPath}`);
    const geminiResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== "GET" ? await req.arrayBuffer() : undefined,
    });

    // 7. 处理并返回响应
    const responseHeaders = new Headers(geminiResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    
    return new Response(geminiResponse.body, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${requestId}] 错误:`, error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
}

serve(handler);
