import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const AUTH_KEY = Deno.env.get("key"); 
const GEMINI_API_KEYS_STR = Deno.env.get("apikey");

let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR.split(',').map(k => k.trim()).filter(k => k.length > 0);
}

function getRandomApiKey() {
  const randomIndex = Math.floor(Math.random() * GEMINI_API_KEYS.length);
  return GEMINI_API_KEYS[randomIndex];
}

serve(async (req) => {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  
  // 1. 处理 CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  try {
    // 2. 身份验证 (验证你在软件里填的 API Key 是否等于 Deno 里的 key)
    const authHeader = req.headers.get("Authorization") || "";
    const xGoogKey = req.headers.get("x-goog-api-key") || "";
    let clientKey = xGoogKey || authHeader.replace("Bearer ", "").trim();

    if (clientKey !== AUTH_KEY) {
      return new Response(JSON.stringify({ error: "认证失败：Key不匹配" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 3. 智能路径修复 (解决 //v1/ 或 404 问题)
    let path = url.pathname.replace(/\/+/g, "/"); // 把多个斜杠替换成单个
    
    // 如果是 OpenAI 模式的路径请求，强制重写到 Google 官方兼容接口
    if (path.includes("/v1/chat/completions")) {
      path = "/v1beta/openai/v1/chat/completions";
    } else if (path.includes("/v1/models")) {
      path = "/v1beta/openai/v1/models";
    }

    // 4. 构建转发请求
    const selectedApiKey = getRandomApiKey();
    const targetUrl = new URL(`${GEMINI_API_BASE}${path}`);
    targetUrl.search = url.search;
    targetUrl.searchParams.set("key", selectedApiKey);

    const forwardHeaders = new Headers(req.headers);
    forwardHeaders.set("host", "generativelanguage.googleapis.com");
    forwardHeaders.delete("Authorization"); // 移除你的私密 Key，防止传给 Google
    forwardHeaders.delete("x-api-key");

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== "GET" ? await req.arrayBuffer() : undefined,
    });

    const newResHeaders = new Headers(response.headers);
    newResHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: newResHeaders,
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
