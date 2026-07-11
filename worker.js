// 职场沟通题库 · DeepSeek 转发层(Cloudflare Worker)
// 作用:把批改请求转发给 DeepSeek,你的 API Key 只存在服务端,网页里不出现。
//
// 部署步骤(约 5 分钟,免费,无需绑卡):
// 1. 注册/登录 https://dash.cloudflare.com
// 2. 左栏 Workers & Pages → Create → Create Worker → 随便起个名(如 drills-proxy)→ Deploy
// 3. 点 Edit code,删掉默认代码,粘贴本文件全部内容 → Deploy
// 4. 回到该 Worker 的 Settings → Variables and Secrets → Add:
//      - 名称 DEEPSEEK_KEY,类型选 Secret,值填你的 sk- 开头的 Key
//      - (可选)名称 ACCESS_CODE,类型 Secret,值随便设一个口令(如 drills2026),
//        设了之后网页端需要填同样口令才能用,防止链接外泄被白嫖
// 5. 记下 Worker 的地址,形如 https://drills-proxy.你的子域.workers.dev
//    把这个地址发给我,我把网页改成指向它。

const RATE_LIMIT = 100;           // 每个 IP 每小时最多请求次数
const ALLOWED_MODEL = "deepseek-v4-pro";

// 简易内存限流(Worker 实例级,够朋友圈规模用)
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, reset: now + 3600_000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 3600_000; }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count > RATE_LIMIT;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return json({ error: { message: "POST only" } }, 405);
    }

    // 可选口令校验
    if (env.ACCESS_CODE) {
      const code = request.headers.get("X-Access-Code") || "";
      if (code !== env.ACCESS_CODE) {
        return json({ error: { message: "口令不正确" } }, 401);
      }
    }

    // 限流
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: { message: "请求太频繁,请一小时后再试" } }, 429);
    }

    // 只允许转发我们自己的请求形状
    let body;
    try { body = await request.json(); } catch { return json({ error: { message: "invalid body" } }, 400); }
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length > 4) {
      return json({ error: { message: "invalid messages" } }, 400);
    }

    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: ALLOWED_MODEL,
        max_tokens: Math.min(body.max_tokens || 1200, 1600),
        temperature: 0.4,
        messages,
      }),
    });

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
